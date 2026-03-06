const { App } = require("@slack/bolt");
const Anthropic = require("@anthropic-ai/sdk");
const { Client } = require("@notionhq/client");
const { google } = require("googleapis");
const fetch = require("node-fetch");

const slack = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const ROOT_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

// Set up Google Drive auth from service account JSON
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const driveAuth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ["https://www.googleapis.com/auth/drive"],
});
const drive = google.drive({ version: "v3", auth: driveAuth });

// In-memory stores
const conversations = {};
const notionPageCache = {};

const SYSTEM_PROMPT = `You are a signage project intake agent for Vend Park, a parking operations company. You work inside a Slack channel called #signage-projects.

Your job is to collect all the information needed to create a signage project. You do this in a conversational, professional but friendly tone — like a smart assistant, not a form.

The operator (Syed) will paste whatever info he has. Your job is to:
1. Parse what he's given you
2. Identify what's missing
3. Ask only for what's missing, grouped logically (don't ask one question at a time if you can ask 2-3 related ones together)
4. Once you have everything, output a clean PROJECT SUMMARY in a structured format

REQUIRED fields for a complete project:
- Property name
- Property address (for vendor routing and delivery)
- Sign types needed (one or more of: Rate Board, Park & Pay, Terms & Conditions)
- For Rate Board: all rate tiers (e.g. 0-1hr: $5, 1-2hr: $8, daily max: $25, monthly: $150)
- For Park & Pay: the payment URL or QR code destination URL
- For Terms & Conditions: whether to use standard T&C text or custom
- Logo: confirm if provided or still needed
- Font style / brand guidelines (if any)
- Preferred deadline
- Any special instructions (e.g. weatherproof material, specific dimensions)

OPTIONAL but useful:
- Property manager name and contact
- Preferred vendor (if known)

Rules:
- Never ask for a field that has already been provided
- Group related follow-up questions together
- When new information is provided that fills in previously missing fields, output a PARTIAL UPDATE block to capture it
- After ALL fields are collected, output the full PROJECT SUMMARY block

Use this format for partial updates (when some but not all info is collected):
---PARTIAL UPDATE---
[only include fields that were just provided or updated]
Property: [if known]
Rates: [if just provided]
Park & Pay URL: [if just provided]
[etc - only fields with new info]
---END PARTIAL---

Use this format only when ALL fields are complete:
---PROJECT SUMMARY---
Property: [name]
Address: [address]
Sign Types: [list]
Rates: [structured rate table or N/A]
Park & Pay URL: [url or N/A]
T&C Type: [Standard / Custom]
Logo: [Provided / Pending]
Brand Guidelines: [details or None specified]
Deadline: [date or ASAP]
Special Instructions: [or None]
Vendor: [if known or TBD]
Status: READY FOR NOTION ✅
---END SUMMARY---`;

// ─── Google Drive helpers ─────────────────────────────────────────────────────

// Find or create a subfolder under the root Signage Projects folder
async function getOrCreatePropertyFolder(propertyName) {
  const safeName = propertyName.replace(/[^a-zA-Z0-9 ]/g, "").trim();

  // Check if folder already exists
  const res = await drive.files.list({
    q: `'${ROOT_DRIVE_FOLDER_ID}' in parents and name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name, webViewLink)",
  });

  if (res.data.files.length > 0) return res.data.files[0];

  // Create new folder
  const folder = await drive.files.create({
    requestBody: {
      name: safeName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [ROOT_DRIVE_FOLDER_ID],
    },
    fields: "id, name, webViewLink",
  });

  return folder.data;
}

// Download file from Slack and upload to Google Drive
async function uploadFileToDrive(fileUrl, fileName, mimeType, folderId) {
  // Download from Slack (requires bot token auth)
  const response = await fetch(fileUrl, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });

  if (!response.ok) throw new Error(`Failed to download file from Slack: ${response.statusText}`);
  const buffer = await response.buffer();

  const { Readable } = require("stream");
  const stream = Readable.from(buffer);

  const uploaded = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: stream,
    },
    fields: "id, name, webViewLink",
  });

  return uploaded.data;
}

// ─── Notion helpers ───────────────────────────────────────────────────────────

async function findNotionPage(threadTs) {
  const res = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: {
      property: "Slack Thread ID",
      rich_text: { equals: threadTs },
    },
  });
  return res.results[0] || null;
}

function buildProperties(data) {
  const props = {};

  if (data["Property"])
    props["title"] = { title: [{ text: { content: data["Property"] } }] };
  if (data["Address"])
    props["address"] = { rich_text: [{ text: { content: data["Address"] } }] };
  if (data["Sign Types"]) {
    const types = data["Sign Types"].split(",").map(s => ({ name: s.trim() })).filter(s => s.name);
    if (types.length) props["Sign Types"] = { multi_select: types };
  }
  if (data["Rates"])
    props["Rates"] = { rich_text: [{ text: { content: data["Rates"] } }] };
  if (data["Park & Pay URL"] && data["Park & Pay URL"] !== "N/A")
    props["URL"] = { url: data["Park & Pay URL"] };
  if (data["T&C Type"])
    props["T&C Type"] = { select: { name: data["T&C Type"] } };
  if (data["Logo"])
    props["Logo"] = { select: { name: data["Logo"] } };
  if (data["Brand Guidelines"])
    props["brand guidelines"] = { rich_text: [{ text: { content: data["Brand Guidelines"] } }] };
  if (data["Deadline"] && data["Deadline"] !== "ASAP") {
    try {
      props["Deadline"] = { date: { start: new Date(data["Deadline"]).toISOString().split("T")[0] } };
    } catch {}
  }
  if (data["Special Instructions"])
    props["Special Instructions"] = { rich_text: [{ text: { content: data["Special Instructions"] } }] };
  if (data["Vendor"])
    props["Vendor Name"] = { rich_text: [{ text: { content: data["Vendor"] } }] };

  return props;
}

async function createNotionPage(threadTs, data, isFinal) {
  const props = buildProperties(data);
  props["Slack Thread ID"] = { rich_text: [{ text: { content: threadTs } }] };
  props["Status"] = { select: { name: isFinal ? "Ready for Design" : "Intake" } };

  await notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: props,
  });
}

async function updateNotionPage(pageId, data, isFinal) {
  const props = buildProperties(data);
  if (isFinal) props["Status"] = { select: { name: "Ready for Design" } };
  await notion.pages.update({ page_id: pageId, properties: props });
}

async function updateDriveLink(pageId, folderUrl) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      "Drive Folder": { url: folderUrl },
    },
  });
}

async function loadConversation(pageId) {
  try {
    const blocks = await notion.blocks.children.list({ block_id: pageId });
    const codeBlock = blocks.results.find(b => b.type === "code");
    if (!codeBlock) return [];
    const raw = codeBlock.code.rich_text.map(r => r.plain_text).join("");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveConversation(pageId, history) {
  try {
    const blocks = await notion.blocks.children.list({ block_id: pageId });
    const codeBlock = blocks.results.find(b => b.type === "code");
    const json = JSON.stringify(history);
    if (codeBlock) {
      await notion.blocks.update({
        block_id: codeBlock.id,
        code: { rich_text: [{ text: { content: json } }], language: "json" },
      });
    } else {
      await notion.blocks.children.append({
        block_id: pageId,
        children: [{
          object: "block", type: "code",
          code: { rich_text: [{ text: { content: json } }], language: "json" },
        }],
      });
    }
  } catch (err) {
    console.error("Failed to save conversation:", err);
  }
}

// ─── Parser ───────────────────────────────────────────────────────────────────

function parseBlock(text, startTag, endTag) {
  const match = text.match(new RegExp(`${startTag}([\\s\\S]*?)${endTag}`));
  if (!match) return null;
  const data = {};
  for (const line of match[1].trim().split("\n")) {
    const [key, ...rest] = line.split(":");
    if (key && rest.length) data[key.trim()] = rest.join(":").trim();
  }
  return data;
}

// ─── File handler ─────────────────────────────────────────────────────────────

async function handleFileUpload({ file, threadTs, say }) {
  try {
    // Find the Notion page for this thread
    let notionPage = null;
    if (notionPageCache[threadTs]) {
      notionPage = { id: notionPageCache[threadTs] };
    } else {
      notionPage = await findNotionPage(threadTs);
      if (notionPage) notionPageCache[threadTs] = notionPage.id;
    }

    if (!notionPage) {
      await say({ text: "⚠️ I couldn't find a project for this thread. Please start a project first, then re-upload the file.", thread_ts: threadTs });
      return;
    }

    // Get property name from Notion for folder naming
    const page = await notion.pages.retrieve({ page_id: notionPage.id });
    const propertyName = page.properties?.title?.title?.[0]?.plain_text || "Unknown Property";

    // Get or create the property subfolder in Drive
    const folder = await getOrCreatePropertyFolder(propertyName);

    // Upload file to Drive
    const uploaded = await uploadFileToDrive(
      file.url_private_download,
      file.name,
      file.mimetype,
      folder.id
    );

    // Update Notion with Drive folder link
    await updateDriveLink(notionPage.id, folder.webViewLink);

    await say({
      text: `📎 *${file.name}* uploaded to Google Drive!\n🗂 Folder: ${folder.webViewLink}\n📄 File: ${uploaded.webViewLink}`,
      thread_ts: threadTs,
    });

  } catch (err) {
    console.error("File upload error:", err);
    await say({ text: "⚠️ Failed to upload file to Google Drive. Please try again.", thread_ts: threadTs });
  }
}

// ─── Main message handler ─────────────────────────────────────────────────────

const handleMessage = async ({ message, event, say }) => {
  const msg = message || event;
  if (!msg) return;
  if (msg.bot_id || msg.subtype) return;

  const threadTs = msg.thread_ts || msg.ts;
  const text = msg.text?.replace(/<@[A-Z0-9]+>/g, "").trim();

  // Handle file uploads
  if (msg.files && msg.files.length > 0) {
    for (const file of msg.files) {
      await handleFileUpload({ file, threadTs, say });
    }
    if (!text) return; // If message is only a file with no text, stop here
  }

  if (!text) return;

  if (!conversations[threadTs]) conversations[threadTs] = [];

  let notionPage = null;
  if (notionPageCache[threadTs]) {
    notionPage = { id: notionPageCache[threadTs] };
  } else {
    notionPage = await findNotionPage(threadTs);
    if (notionPage) notionPageCache[threadTs] = notionPage.id;
  }

  let history = [];
  if (notionPage) history = await loadConversation(notionPage.id);

  history.push({ role: "user", content: text });

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: history,
    });

    const reply = response.content.find(b => b.type === "text")?.text || "Sorry, something went wrong.";
    history.push({ role: "assistant", content: reply });

    // Strip structured blocks before sending to Slack
    const cleanReply = reply
      .replace(/---PARTIAL UPDATE---[\s\S]*?---END PARTIAL---/g, "")
      .replace(/---PROJECT SUMMARY---[\s\S]*?---END SUMMARY---/g, "")
      .trim();

    await say({ text: cleanReply, thread_ts: threadTs });

    // Handle PARTIAL UPDATE
    if (reply.includes("---PARTIAL UPDATE---")) {
      const data = parseBlock(reply, "---PARTIAL UPDATE---", "---END PARTIAL---");
      if (data) {
        if (!notionPage) {
          await createNotionPage(threadTs, data, false);
          notionPage = await findNotionPage(threadTs);
          if (notionPage) notionPageCache[threadTs] = notionPage.id;
          await say({ text: "📋 Project started in Notion — I'll keep updating it as you share more info.", thread_ts: threadTs });
        } else {
          await updateNotionPage(notionPage.id, data, false);
          await say({ text: "📝 Notion updated with the new information!", thread_ts: threadTs });
        }
      }
    }

    // Handle full PROJECT SUMMARY
    if (reply.includes("---PROJECT SUMMARY---")) {
      const data = parseBlock(reply, "---PROJECT SUMMARY---", "---END SUMMARY---");
      if (data) {
        if (!notionPage) {
          await createNotionPage(threadTs, data, true);
          notionPage = await findNotionPage(threadTs);
          if (notionPage) notionPageCache[threadTs] = notionPage.id;
        } else {
          await updateNotionPage(notionPage.id, data, true);
        }
        await say({ text: "✅ All done! Notion project is complete and marked *Ready for Design*.", thread_ts: threadTs });
      }
    }

    if (notionPage) await saveConversation(notionPage.id, history);

  } catch (err) {
    console.error("Error:", err);
    await say({ text: "⚠️ Something went wrong. Please try again.", thread_ts: threadTs });
  }
};

slack.message(async (args) => {
  if (args.message?.text?.includes(`<@`)) return;
  await handleMessage(args);
});
slack.event("app_mention", async (args) => {
  await handleMessage(args);
});

(async () => {
  await slack.start();
  console.log("⚡ Signage Agent is running");
})();
