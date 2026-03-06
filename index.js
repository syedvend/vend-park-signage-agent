const { App } = require("@slack/bolt");
const Anthropic = require("@anthropic-ai/sdk");

const slack = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory store for conversation history per Slack thread
const conversations = {};

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
- After all fields are collected, output a structured PROJECT SUMMARY block using this exact format:

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
---END SUMMARY---

Only output the PROJECT SUMMARY once you have confirmed all required fields.`;

slack.message(async ({ message, say }) => {
  // Ignore bot messages
  if (message.subtype === "bot_message" || message.bot_id) return;

  const threadTs = message.thread_ts || message.ts;
  const userId = message.user;

  // Initialize conversation history for this thread if new
  if (!conversations[threadTs]) {
    conversations[threadTs] = [];
  }

  // Add the user's message to history
  conversations[threadTs].push({
    role: "user",
    content: message.text,
  });

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: conversations[threadTs],
    });

    const reply = response.content.find((b) => b.type === "text")?.text || "Sorry, something went wrong.";

    // Add assistant reply to history
    conversations[threadTs].push({
      role: "assistant",
      content: reply,
    });

    // Reply in thread to keep things organized
    await say({
      text: reply,
      thread_ts: threadTs,
    });
  } catch (err) {
    console.error("Claude API error:", err);
    await say({
      text: "⚠️ Something went wrong. Please try again.",
      thread_ts: threadTs,
    });
  }
});

(async () => {
  await slack.start();
  console.log("⚡ Signage Agent is running");
})();
