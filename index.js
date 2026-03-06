const { App } = require("@slack/bolt");
const Anthropic = require("@anthropic-ai/sdk");
const { Client } = require("@notionhq/client");
const { google } = require("googleapis");
const fetch = require("node-fetch");
const { Readable } = require("stream");

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

Your job has two modes:

MODE 1 — PROJECT INTAKE
When the user wants to create or update a signage project, collect all required information conversationally.

REQUIRED fields for a complete project:
- Property name
- Property address
- Sign types needed (Rate Board, Park & Pay, Terms & Conditions)
- For Rate Board: all rate tiers
- For Park & Pay: payment URL or QR code destination
- For Terms & Conditions: standard or custom
- Logo: provided or still needed
- Font style / brand guidelines
- Preferred deadline
- Special instructions

Rules:
- Never ask for a field already provided
- Group related follow-up questions together
- Output PARTIAL UPDATE blocks as info comes in
- Output full PROJECT SUMMARY only when ALL fields are complete

Use this format for partial updates:
---PARTIAL UPDATE---
Property: [if known]
Address: [if known]
Sign Types: [if known]
Rates: [if provided]
Park & Pay URL: [if provided]
T&C Type: [if provided]
Logo: [if provided]
Brand Guidelines: [if provided]
Deadline: [if provided]
Special Instructions: [if provided]
Vendor: [if provided]
---END PARTIAL---

Use this format when ALL fields are complete:
---PROJECT SUMMARY---
Property: [name]
Address: [address]
Sign Types: [list]
Rates: [rate table or N/A]
Park & Pay URL: [url or N/A]
T&C Type: [Standard / Custom]
Logo: [Provided / Pending]
Brand Guidelines: [details or None specified]
Deadline: [date or ASAP]
Special Instructions: [or None]
Vendor: [if known or TBD]
Status: READY FOR NOTION ✅
---END SUMMARY---

MODE 2 — FILE RETRIEVAL
When the user asks to see, share, or retrieve files for a property, output a FILE REQUEST block:

---FILE REQUEST---
Property: [exact property name they mentioned]
---END FILE REQUEST---

Examples that trigger MODE 2:
- "Share the signage for Treat Towers"
- "What files do we have for Santana Row?"
- "Send me the Bakery Square designs"
- "Can you pull up the files for [property]?"

Always output the FILE REQUEST block for these — do not ask follow-up questions.`;

// ─── Google Drive helpers ─────────────────────────────────────────────────────

async function getOrCreatePropertyFolder(propertyName) {
  const safeName = propertyName.replace(/[^a-zA-Z0-9 ]/g, "").trim();
  const res = await drive.files.list({
    q: `'${ROOT_DRIVE_FOLDER_ID}' in parents and name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name, webViewLink)",
  });
  if (res.data.files.length > 0) return res.data.files[0];

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

async function uploadFileToDrive(fileUrl, fileName, mimeType, folderId) {
  const response = await fetch(fileUrl, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });
  if (!response.ok) throw new Error(`Failed to download from Slack: ${response.statusText}`);
  const buffer = await response.buffer();
  const stream = Readable.from(buffer);

  const uploaded = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType, body: stream },
    fields: "id, name, webViewLink",
  });
  return uploaded.data;
}

// List all files in a property's Drive folder
async function getFilesForProperty(propertyName) {
  const safeName = propertyName.replace(/[^a-zA-Z0-9 ]/g, "").trim();
  const folderRes = await drive.files.list({
    q: `'${ROOT_DRIVE_FOLDER_ID}' in parents and name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name, webViewLink)",
  });

  if (folderRes.data.files.length === 0) return null;
  const folder = folderRes.data.files[0];

  const filesRes = await drive.files.list({
    q: `'${folder.id}' in parents and trashed = false`,
    fields: "files(id, name, webViewLink, mimeType, createdTime)",
    orderBy: "createdTime desc",
  });

  return { folder, files: filesRes.data.files };
}

// ─── Notion helpers ───────────────────────────────────────────────────────────

async function findNotionPage(threadTs) {
  const res = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: { property: "Slack Thread ID", rich_text: { equals: threadTs } },
  });
  return res.results[0] || null;
}

// Find Notion page by property name (for file retrieval)
async function findNotionPageByProperty(propertyName) {
  const res = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: { property: "title", rich_text: { contains: propertyName } },
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
  await notion.pages.create({ parent: { database_id: NOTION_DATABASE_ID }, properties: props });
}

async function updateNotionPage(pageId, data, isFinal) {
  const props = buildProperties(data);
  if (isFinal) props["Status"] = { select: { name: "Ready for Design" } };
  await notion.pages.update({ page_id: pageId, properties: props });
}

async function updateDriveLink(pageId, folderUrl) {
  await notion.pages.update({
    page_id: pageId,
    properties: { "Drive Folder": { url: folderUrl } },
  });
}

async function loadConversation(pageId) {
  try {
    const blocks = await notion.blocks.children.list({ block_id: pageId });
    const codeBlock = blocks.results.find(b => b.type === "code");
    if (!codeBlock) return [];
    const raw = codeBlock.code.rich_text.map(r => r.plain_text).join("");
    return JSON.parse(raw);
  } catch { return []; }
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
        children: [{ object: "block", type: "code",
          code: { rich_text: [{ text: { content: json } }], language: "json" } }],
      });
    }
  } catch (err) { console.error("Failed to save conversation:", err); }
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

// ─── File upload handler ──────────────────────────────────────────────────────

async function handleFileUpload({ file, threadTs, say }) {
  try {
    let notionPage = null;
    if (notionPageCache[threadTs]) {
      notionPage = { id: notionPageCache[threadTs] };
    } else {
      notionPage = await findNotionPage(threadTs);
      if (notionPage) notionPageCache[threadTs] = notionPage.id;
    }

    if (!notionPage) {
      await say({ text: "⚠️ No project found for this thread. Please start a project first, then re-upload the file.", thread_ts: threadTs });
      return;
    }

    const page = await notion.pages.retrieve({ page_id: notionPage.id });
    const propertyName = page.properties?.title?.title?.[0]?.plain_text || "Unknown Property";

    const folder = await getOrCreatePropertyFolder(propertyName);
    const uploaded = await uploadFileToDrive(file.url_private_download, file.name, file.mimetype, folder.id);
    await updateDriveLink(notionPage.id, folder.webViewLink);

    await say({
      text: `📎 *${file.name}* uploaded successfully!\n🗂 Folder: ${folder.webViewLink}\n📄 File: ${uploaded.webViewLink}`,
      thread_ts: threadTs,
    });
  } catch (err) {
    console.error("File upload error:", err);
    await say({ text: "⚠️ Failed to upload file to Google Drive. Please try again.", thread_ts: threadTs });
  }
}

// ─── File retrieval handler ───────────────────────────────────────────────────

async function handleFileRetrieval({ propertyName, threadTs, say }) {
  try {
    const result = await getFilesForProperty(propertyName);

    if (!result) {
      await say({
        text: `🔍 No Google Drive folder found for *${propertyName}*. Files may not have been uploaded yet.`,
        thread_ts: threadTs,
      });
      return;
    }

    const { folder, files } = result;

    if (files.length === 0) {
      await say({
        text: `📁 Found the folder for *${propertyName}* but it's empty: ${folder.webViewLink}`,
        thread_ts: threadTs,
      });
      return;
    }

    const fileList = files.map(f => `• <${f.webViewLink}|${f.name}>`).join("\n");
    await say({
      text: `📁 Here are the files for *${propertyName}*:\n\n${fileList}\n\n🗂 Full folder: ${folder.webViewLink}`,
      thread_ts: threadTs,
    });
  } catch (err) {
    console.error("File retrieval error:", err);
    await say({ text: "⚠️ Failed to retrieve files. Please try again.", thread_ts: threadTs });
  }
}

// ─── Main message handler ─────────────────────────────────────────────────────

const handleMessage = async ({ message, event, say }) => {
  const msg = message || event;
  if (!msg) return;
  if (msg.bot_id || msg.subtype) return;

  const threadTs = msg.thread_ts || msg.ts;
  const text = msg.text?.replace(/<@[A-Z0-9]+>/g, "").trim();

  if (!text && (!msg.files || msg.files.length === 0)) return;

  // Process text through Claude first so Notion page exists before file upload
  if (text) {
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

      // Handle FILE REQUEST — retrieve files from Drive
      if (reply.includes("---FILE REQUEST---")) {
        const data = parseBlock(reply, "---FILE REQUEST---", "---END FILE REQUEST---");
        if (data?.["Property"]) {
          await handleFileRetrieval({ propertyName: data["Property"], threadTs, say });
          return;
        }
      }

      const cleanReply = reply
        .replace(/---PARTIAL UPDATE---[\s\S]*?---END PARTIAL---/g, "")
        .replace(/---PROJECT SUMMARY---[\s\S]*?---END SUMMARY---/g, "")
        .replace(/---FILE REQUEST---[\s\S]*?---END FILE REQUEST---/g, "")
        .trim();

      if (cleanReply) await say({ text: cleanReply, thread_ts: threadTs });

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
  }

  // Handle file uploads AFTER text so Notion page exists
  if (msg.files && msg.files.length > 0) {
    for (const file of msg.files) {
      await handleFileUpload({ file, threadTs, say });
    }
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
