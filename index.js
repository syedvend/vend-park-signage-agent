const { App } = require("@slack/bolt");
const Anthropic = require("@anthropic-ai/sdk");
const { Client } = require("@notionhq/client");

const slack = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

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

// ─── Notion helpers ───────────────────────────────────────────────────────────

// Find an existing Notion page by Slack thread ID
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

// Build Notion properties object from parsed data (only include non-empty fields)
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

// Create a new Notion page for this project
async function createNotionPage(threadTs, data, isFinal) {
  const props = buildProperties(data);
  props["Slack Thread ID"] = { rich_text: [{ text: { content: threadTs } }] };
  props["Status"] = { select: { name: isFinal ? "Ready for Design" : "Intake" } };

  await notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: props,
  });
}

// Update an existing Notion page with new fields
async function updateNotionPage(pageId, data, isFinal) {
  const props = buildProperties(data);
  if (isFinal) props["Status"] = { select: { name: "Ready for Design" } };

  await notion.pages.update({ page_id: pageId, properties: props });
}

// Load conversation history stored in Notion page body
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

// Save conversation history into a code block on the Notion page
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

// ─── Main message handler ─────────────────────────────────────────────────────

const handleMessage = async ({ message, event, say }) => {
  const msg = message || event;
  if (!msg) return;
  if (msg.bot_id || msg.subtype) return;

  const threadTs = msg.thread_ts || msg.ts;
  const text = msg.text?.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!text) return;

  // Check if a Notion page already exists for this thread
  let notionPage = await findNotionPage(threadTs);
  let history = [];

  if (notionPage) {
    // Load persisted conversation history from Notion
    history = await loadConversation(notionPage.id);
  }

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

    await say({ text: reply, thread_ts: threadTs });

    // Handle PARTIAL UPDATE — create or update Notion page with new fields
    if (reply.includes("---PARTIAL UPDATE---")) {
      const data = parseBlock(reply, "---PARTIAL UPDATE---", "---END PARTIAL---");
      if (data) {
        if (!notionPage) {
          await createNotionPage(threadTs, data, false);
          notionPage = await findNotionPage(threadTs);
          await say({ text: "📋 Project started in Notion — I'll keep updating it as you share more info.", thread_ts: threadTs });
        } else {
          await updateNotionPage(notionPage.id, data, false);
          await say({ text: "📝 Notion updated with the new information!", thread_ts: threadTs });
        }
      }
    }

    // Handle full PROJECT SUMMARY — final update, mark as Ready for Design
    if (reply.includes("---PROJECT SUMMARY---")) {
      const data = parseBlock(reply, "---PROJECT SUMMARY---", "---END SUMMARY---");
      if (data) {
        if (!notionPage) {
          await createNotionPage(threadTs, data, true);
        } else {
          await updateNotionPage(notionPage.id, data, true);
        }
        await say({ text: "✅ All done! Notion project is complete and marked *Ready for Design*.", thread_ts: threadTs });
        notionPage = await findNotionPage(threadTs);
      }
    }

    // Always persist the latest conversation history to Notion
    if (notionPage) await saveConversation(notionPage.id, history);

  } catch (err) {
    console.error("Error:", err);
    await say({ text: "⚠️ Something went wrong. Please try again.", thread_ts: threadTs });
  }
};

// Only use app_mention to avoid double-firing when bot is @mentioned
slack.message(async (args) => {
  // Skip if this is an @mention — app_mention will handle it
  if (args.message?.text?.includes(`<@`)) return;
  await handleMessage(args);
});
slack.event("app_mention", handleMessage);

(async () => {
  await slack.start();
  console.log("⚡ Signage Agent is running");
})();
