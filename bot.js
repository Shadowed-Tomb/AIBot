import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import { init } from '@heyputer/puter.js/src/init.cjs';
import { fal } from '@fal-ai/client';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
dotenv.config();

const {
  TELEGRAM_BOT_TOKEN,
  PUTER_AUTH_TOKEN,
  FAL_KEY,
  OWNER_ID,
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH
} = process.env;

// Validate configurations
if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === 'your_telegram_bot_token') {
  console.error('❌ Error: TELEGRAM_BOT_TOKEN is not set in the .env file!');
  process.exit(1);
}
if (!PUTER_AUTH_TOKEN || PUTER_AUTH_TOKEN === 'your_puter_auth_token') {
  console.error('❌ Error: PUTER_AUTH_TOKEN is not set in the .env file!');
  process.exit(1);
}
if (!FAL_KEY || FAL_KEY === 'your_fal_api_key') {
  console.warn('⚠️ Warning: FAL_KEY is not set. Video generation features will not work.');
}
if (!OWNER_ID || OWNER_ID === 'your_owner_id') {
  console.warn('⚠️ Warning: OWNER_ID is not configured. Owner commands will not function.');
}
if (!TELEGRAM_API_ID || TELEGRAM_API_ID === 'your_api_id' || !TELEGRAM_API_HASH || TELEGRAM_API_HASH === 'your_api_hash') {
  console.warn('⚠️ Warning: TELEGRAM_API_ID or TELEGRAM_API_HASH is not set. Telegram API features will be restricted.');
}


console.log('Initializing Puter SDK...');
const puter = init(PUTER_AUTH_TOKEN);

console.log('Initializing Fal SDK...');
fal.config({ credentials: FAL_KEY });

console.log('Initializing Telegram Bot...');
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// Database configuration and helper functions
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'db.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = fs.readFileSync(DB_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Error loading database:', e);
  }
  return { admins: [], banned: [], usernameMap: {}, userDetails: {} };
}

function saveDB(db) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving database:', e);
  }
}

// Track user details
function trackUser(ctx) {
  if (!ctx.from) return;
  const db = loadDB();
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? ctx.from.username.toLowerCase() : null;
  const firstName = ctx.from.first_name || '';
  const lastName = ctx.from.last_name || '';
  const fullName = `${firstName} ${lastName}`.trim() || 'UNKNOWN USER';

  let changed = false;

  if (username && db.usernameMap[username] !== userId) {
    db.usernameMap[username] = userId;
    changed = true;
  }
  
  if (!db.userDetails) {
    db.userDetails = {};
  }
  if (!db.userDetails[userId] || db.userDetails[userId].fullName !== fullName || db.userDetails[userId].username !== username) {
    db.userDetails[userId] = { username, fullName };
    changed = true;
  }

  if (changed) {
    saveDB(db);
  }
}

// Escape HTML special characters for Telegram HTML parse mode
function escapeHTML(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Formatting helper: Emojis to text symbols, UPPERCASE, and HTML escaping
function toMonoCaps(text) {
  if (!text) return '';
  
  let cleanText = text;
  
  const emojiMap = {
    '🤖': '[BOT]',
    '💬': '[CHAT]',
    '🖼️': '[IMAGE]',
    '🎨': '[IMAGINE]',
    '🎥': '[ANIMATE]',
    '🧹': '[CLEAR]',
    '❌': '[X]',
    '⚠️': '[!]',
    '⏱️': '[WAIT]',
    '🧐': '[ANALYZE]',
    '🚀': '[OK]',
    '😊': ':-)',
    '🙂': ':-)',
    '😄': ':-D',
    '😁': ':-D',
    '😆': ':-D',
    '😍': ':-*',
    '😎': 'B-)',
    '😢': ':-(',
    '😭': ';-(',
    '😡': '>:-(',
    '👍': '(YES)',
    '👎': '(NO)',
  };

  // Replace mapped emojis
  for (const [emoji, replacement] of Object.entries(emojiMap)) {
    cleanText = cleanText.split(emoji).join(replacement);
  }

  // Remove other emojis
  const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F1E6}-\u{1F1FF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA70}-\u{1FAFF}]/gu;
  cleanText = cleanText.replace(emojiRegex, '');

  // Convert to UPPERCASE
  const upperText = cleanText.toUpperCase();

  // Escape HTML characters
  return escapeHTML(upperText);
}

// Send monospaced uppercase blockquote message
async function sendMonoReply(ctx, text, options = {}) {
  const formatted = `<blockquote><code>${toMonoCaps(text)}</code></blockquote>`;
  const extra = {
    ...options,
    parse_mode: 'HTML',
    reply_to_message_id: options.reply_to_message_id || ctx.message?.message_id
  };
  return ctx.reply(formatted, extra);
}

// Edit monospaced uppercase blockquote message
async function editMonoMessage(ctx, messageId, text) {
  const formatted = `<blockquote><code>${toMonoCaps(text)}</code></blockquote>`;
  return ctx.telegram.editMessageText(
    ctx.chat.id,
    messageId,
    null,
    formatted,
    { parse_mode: 'HTML' }
  );
}

// Check roles
function isOwner(userId) {
  if (!userId || !OWNER_ID) return false;
  return userId.toString() === OWNER_ID.toString();
}

function isAdminOrOwner(userId) {
  if (!userId) return false;
  const userIdStr = userId.toString();
  if (isOwner(userIdStr)) return true;
  const db = loadDB();
  return db.admins && db.admins.includes(userIdStr);
}

function isUserBanned(userId) {
  if (!userId) return false;
  const db = loadDB();
  return db.banned && db.banned.includes(userId.toString());
}

// Global Error Handler to prevent bot crashes
bot.catch((err, ctx) => {
  console.error(`⚠️ Bot error encountered during ${ctx.updateType}:`, err);
  sendMonoReply(ctx, '⚠️ Oops! An unexpected error occurred. Please try again later.').catch((e) => {
    console.error('Failed to send error notification:', e);
  });
});


// Conversational memory store
const SYSTEM_MESSAGE = {
  role: 'system',
  content: 'YOU ARE A FRIENDLY, POLITE, AND RESPECTFUL AI ASSISTANT. YOU MUST ALWAYS BE KIND AND HELPFUL. YOU MUST NEVER GENERATE TOXIC, ABUSIVE, EXPLICIT, OR HARMFUL RESPONSES. WRITE YOUR REPLIES IN ALL-CAPS. DO NOT USE EMOJIS; INSTEAD, USE FRIENDLY TEXT EMOTICONS AND SYMBOLS (LIKE :-), :-D, B-), :-P, <3, etc.). KEEP YOUR ANSWERS SAFE, HELPFUL, AND CONCISE.'
};
const conversationHistory = {};
const MAX_HISTORY = 11; // 1 system message + 10 conversation messages (5 turns)

function updateHistory(userId, role, content) {
  if (!conversationHistory[userId]) {
    conversationHistory[userId] = [SYSTEM_MESSAGE];
  }
  conversationHistory[userId].push({ role, content });
  
  // If the history length exceeds the maximum, keep system message (index 0) and slide the rest
  if (conversationHistory[userId].length > MAX_HISTORY) {
    conversationHistory[userId].splice(1, 1); // Delete the oldest message after the system message
  }
}

function clearHistory(userId) {
  conversationHistory[userId] = [SYSTEM_MESSAGE];
}

// Rate Limiting (Anti-Spam)
const rateLimits = {}; // { [userId]: { lastMessage: timestamp, lastGeneration: timestamp } }

function getRateLimitDelay(userId, type = 'chat') {
  const now = Date.now();
  if (!rateLimits[userId]) {
    rateLimits[userId] = { lastMessage: 0, lastGeneration: 0 };
  }

  const limit = type === 'generation' ? 30000 : 2000; // 30 seconds for images/videos, 2 seconds for chat
  const lastTime = type === 'generation' ? rateLimits[userId].lastGeneration : rateLimits[userId].lastMessage;
  const elapsed = now - lastTime;

  if (elapsed < limit) {
    return Math.ceil((limit - elapsed) / 1000);
  }

  // Update last activity timestamp
  if (type === 'generation') {
    rateLimits[userId].lastGeneration = now;
  } else {
    rateLimits[userId].lastMessage = now;
  }
  return 0;
}

// Basic Local Moderation Filter (to prevent API abuse and cost overrun)
const ABUSE_BLACKLIST = [
  'nsfw', 'porn', 'sex', 'naked', 'gore', 'kill', 'suicide', 'bomb', 'terrorist', 'explode', 'murder',
  'fuck', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'pussy', 'nude', 'hentai', 'drugs', 'cocaine', 'meth'
];

function isAbusive(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return ABUSE_BLACKLIST.some(word => lower.includes(word));
}

// Global middleware to track users and enforce bans
bot.use(async (ctx, next) => {
  if (ctx.from) {
    trackUser(ctx);
    
    // Check if user is banned
    if (isUserBanned(ctx.from.id)) {
      if (ctx.chat.type === 'private') {
        await sendMonoReply(ctx, '❌ ACCESS DENIED: YOU ARE BANNED FROM USING THIS BOT. :-(');
      }
      return; // Stop processing updates from this user
    }
  }
  await next();
});


// Dynamic menu based on user role
function getHelpMessage(userId) {
  const isUserAdmin = isAdminOrOwner(userId);
  const isUserOwner = isOwner(userId);

  let msg = `🤖 WELCOME TO THE XAI GROK BOT! :-)

HERE IS WHAT I CAN DO:
💬 CHAT: SIMPLY MESSAGE ME ANYTHING TO START CHATTING WITH GROK!
🖼️ ANALYZE IMAGES: SEND ME A PHOTO WITH A CAPTION TO ASK ME QUESTIONS ABOUT IT.
🎨 GENERATE IMAGES: USE THE COMMAND:
/IMAGINE <YOUR DETAILED PROMPT>
(E.G., /IMAGINE A FUTURISTIC CYBERPUNK CITY WITH NEON LIGHTS)
🎥 GENERATE VIDEOS: USE THE COMMAND:
/ANIMATE <YOUR DESCRIPTION OF ACTION & SOUND>
(E.G., /ANIMATE A DRONE FLYING THROUGH A RAINY ALLEYWAY)
YOU CAN ALSO REPLY TO ANY PHOTO WITH /ANIMATE <PROMPT> TO TURN THAT PHOTO INTO A VIDEO!
🧹 RESET MEMORY: TYPE /RESET TO CLEAR OUR CHAT HISTORY.`;

  if (isUserAdmin) {
    msg += `\n\n🛡️ ADMIN COMMANDS:
/BAN <USER_ID_OR_USERNAME>: BAN A USER FROM USING THE BOT. (OR REPLY WITH /BAN)
/UNBAN <USER_ID_OR_USERNAME>: UNBAN A USER. (OR REPLY WITH /UNBAN)
/BANLIST: LIST ALL BANNED USERS.
/ADMINLIST: LIST ALL ADMINS AND OWNER.`;
  }

  if (isUserOwner) {
    msg += `\n\n👑 OWNER COMMANDS:
/ADDADMIN <USER_ID_OR_USERNAME>: MAKE A USER ADMIN. (OR REPLY WITH /ADDADMIN)
/DELADMIN <USER_ID_OR_USERNAME>: REMOVE ADMIN STATUS. (OR REPLY WITH /DELADMIN)`;
  }

  msg += `\n\nSAFETY RULES:
- BE RESPECTFUL. ABUSIVE/NSFW REQUESTS WILL BE AUTOMATICALLY BLOCKED.
- GENERAL CHAT IS RATE-LIMITED TO 1 REQUEST PER 2 SECONDS.
- MEDIA GENERATION (/IMAGINE & /ANIMATE) IS RATE-LIMITED TO 1 REQUEST PER 30 SECONDS.`;

  return msg;
}

bot.start((ctx) => sendMonoReply(ctx, getHelpMessage(ctx.from.id)));
bot.help((ctx) => sendMonoReply(ctx, getHelpMessage(ctx.from.id)));

bot.command('reset', (ctx) => {
  const userId = ctx.from.id;
  clearHistory(userId);
  sendMonoReply(ctx, '🧹 Conversations history cleared!');
});

// Helper to extract target user ID from command arguments or replies
function getTargetUser(ctx, arg) {
  let targetUserId = null;
  let targetUsername = null;
  let targetName = 'USER';

  if (ctx.message.reply_to_message && ctx.message.reply_to_message.from) {
    targetUserId = ctx.message.reply_to_message.from.id.toString();
    targetUsername = ctx.message.reply_to_message.from.username;
    targetName = `${ctx.message.reply_to_message.from.first_name || ''} ${ctx.message.reply_to_message.from.last_name || ''}`.trim() || 'USER';
  } else if (arg) {
    if (arg.startsWith('@')) {
      const username = arg.substring(1).toLowerCase();
      const db = loadDB();
      targetUserId = db.usernameMap[username];
      targetUsername = username;
      if (targetUserId && db.userDetails && db.userDetails[targetUserId]) {
        targetName = db.userDetails[targetUserId].fullName;
      }
    } else {
      targetUserId = arg;
      const db = loadDB();
      if (db.userDetails && db.userDetails[targetUserId]) {
        targetName = db.userDetails[targetUserId].fullName;
        targetUsername = db.userDetails[targetUserId].username;
      }
    }
  }

  return { targetUserId, targetUsername, targetName };
}

bot.command('ban', async (ctx) => {
  const senderId = ctx.from.id;
  if (!isAdminOrOwner(senderId)) {
    return sendMonoReply(ctx, '❌ PERMISSION DENIED: ONLY ADMINS OR THE OWNER CAN BAN USERS. :-(');
  }

  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const { targetUserId, targetUsername, targetName } = getTargetUser(ctx, arg);

  if (!targetUserId) {
    return sendMonoReply(ctx, 'PLEASE SPECIFY A USER ID OR USERNAME, OR REPLY TO THEIR MESSAGE. EXAMPLE:\n/BAN 123456789\n/BAN @USERNAME');
  }

  if (isOwner(targetUserId)) {
    return sendMonoReply(ctx, '❌ ERROR: YOU CANNOT BAN THE OWNER! B-)');
  }

  if (targetUserId === senderId.toString()) {
    return sendMonoReply(ctx, '❌ ERROR: YOU CANNOT BAN YOURSELF! :-P');
  }

  const db = loadDB();
  if (db.banned.includes(targetUserId)) {
    return sendMonoReply(ctx, `[!] USER ${targetUsername ? '@' + targetUsername : targetUserId} (${targetName}) IS ALREADY BANNED.`);
  }

  db.banned.push(targetUserId);
  saveDB(db);

  if (ctx.chat.type !== 'private') {
    try {
      await ctx.banChatMember(parseInt(targetUserId));
      await sendMonoReply(ctx, `[+] BANNED AND KICKED: USER ${targetUsername ? '@' + targetUsername : targetUserId} (${targetName}) HAS BEEN BANNED.`);
    } catch (err) {
      await sendMonoReply(ctx, `[+] BANNED LOCALLY: USER ${targetUsername ? '@' + targetUsername : targetUserId} (${targetName}) BANNED FROM BOT INTERACTION. (COULD NOT KICK FROM CHAT - CHECK BOT PERMISSIONS)`);
    }
  } else {
    await sendMonoReply(ctx, `[+] BANNED: USER ${targetUsername ? '@' + targetUsername : targetUserId} (${targetName}) HAS BEEN BANNED.`);
  }
});

bot.command('unban', async (ctx) => {
  const senderId = ctx.from.id;
  if (!isAdminOrOwner(senderId)) {
    return sendMonoReply(ctx, '❌ PERMISSION DENIED: ONLY ADMINS OR THE OWNER CAN UNBAN USERS. :-(');
  }

  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const { targetUserId, targetUsername, targetName } = getTargetUser(ctx, arg);

  if (!targetUserId) {
    return sendMonoReply(ctx, 'PLEASE SPECIFY A USER ID OR USERNAME, OR REPLY TO THEIR MESSAGE. EXAMPLE:\n/UNBAN 123456789\n/UNBAN @USERNAME');
  }

  const db = loadDB();
  if (!db.banned.includes(targetUserId)) {
    return sendMonoReply(ctx, `[!] USER ${targetUsername ? '@' + targetUsername : targetUserId} (${targetName}) IS NOT BANNED.`);
  }

  db.banned = db.banned.filter(id => id !== targetUserId);
  saveDB(db);

  if (ctx.chat.type !== 'private') {
    try {
      await ctx.unbanChatMember(parseInt(targetUserId));
    } catch (err) {
      console.error('Failed to unban from group chat:', err);
    }
  }

  await sendMonoReply(ctx, `[+] UNBANNED: USER ${targetUsername ? '@' + targetUsername : targetUserId} (${targetName}) HAS BEEN UNBANNED. :-)`);
});

bot.command('banlist', async (ctx) => {
  const senderId = ctx.from.id;
  if (!isAdminOrOwner(senderId)) {
    return sendMonoReply(ctx, '❌ PERMISSION DENIED: ONLY ADMINS OR THE OWNER CAN VIEW THE BAN LIST. :-(');
  }

  const db = loadDB();
  if (!db.banned || db.banned.length === 0) {
    return sendMonoReply(ctx, 'THE BAN LIST IS EMPTY. (O_O)');
  }

  let listMsg = 'BANNED USERS:\n';
  db.banned.forEach((userId, index) => {
    let name = 'UNKNOWN';
    let username = '';
    if (db.userDetails && db.userDetails[userId]) {
      name = db.userDetails[userId].fullName;
      username = db.userDetails[userId].username ? ` (@${db.userDetails[userId].username})` : '';
    }
    listMsg += `${index + 1}. ID: ${userId}${username} - NAME: ${name}\n`;
  });

  await sendMonoReply(ctx, listMsg);
});

bot.command('addadmin', async (ctx) => {
  const senderId = ctx.from.id;
  if (!isOwner(senderId)) {
    return sendMonoReply(ctx, '❌ PERMISSION DENIED: ONLY THE OWNER CAN ADD ADMINS. :-(');
  }

  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const { targetUserId, targetUsername, targetName } = getTargetUser(ctx, arg);

  if (!targetUserId) {
    return sendMonoReply(ctx, 'PLEASE SPECIFY A USER ID OR USERNAME, OR REPLY TO THEIR MESSAGE. EXAMPLE:\n/ADDADMIN 123456789\n/ADDADMIN @USERNAME');
  }

  const db = loadDB();
  if (db.admins.includes(targetUserId)) {
    return sendMonoReply(ctx, `[!] USER ${targetUsername ? '@' + targetUsername : targetUserId} (${targetName}) IS ALREADY AN ADMIN.`);
  }

  db.admins.push(targetUserId);
  saveDB(db);

  await sendMonoReply(ctx, `[+] ADMIN ADDED: USER ${targetUsername ? '@' + targetUsername : targetUserId} (${targetName}) IS NOW AN ADMIN. :-)`);
});

bot.command('deladmin', async (ctx) => {
  const senderId = ctx.from.id;
  if (!isOwner(senderId)) {
    return sendMonoReply(ctx, '❌ PERMISSION DENIED: ONLY THE OWNER CAN REMOVE ADMINS. :-(');
  }

  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const { targetUserId, targetUsername, targetName } = getTargetUser(ctx, arg);

  if (!targetUserId) {
    return sendMonoReply(ctx, 'PLEASE SPECIFY A USER ID OR USERNAME, OR REPLY TO THEIR MESSAGE. EXAMPLE:\n/DELADMIN 123456789\n/DELADMIN @USERNAME');
  }

  const db = loadDB();
  if (!db.admins.includes(targetUserId)) {
    return sendMonoReply(ctx, `[!] USER ${targetUsername ? '@' + targetUsername : targetUserId} (${targetName}) IS NOT AN ADMIN.`);
  }

  db.admins = db.admins.filter(id => id !== targetUserId);
  saveDB(db);

  await sendMonoReply(ctx, `[+] ADMIN REMOVED: USER ${targetUsername ? '@' + targetUsername : targetUserId} (${targetName}) IS NO LONGER AN ADMIN. :-P`);
});

bot.command('adminlist', async (ctx) => {
  const db = loadDB();
  
  let listMsg = `BOT ADMINS:\n`;
  listMsg += `OWNER: ${OWNER_ID ? OWNER_ID : 'NOT CONFIGURED'}`;
  
  if (OWNER_ID && db.userDetails && db.userDetails[OWNER_ID]) {
    const details = db.userDetails[OWNER_ID];
    const username = details.username ? ` (@${details.username})` : '';
    listMsg += `${username} - NAME: ${details.fullName}`;
  }
  listMsg += '\n\n';

  if (!db.admins || db.admins.length === 0) {
    listMsg += 'NO OTHER ADMINS ADDED.';
  } else {
    listMsg += 'ADMINS:\n';
    db.admins.forEach((userId, index) => {
      let name = 'UNKNOWN';
      let username = '';
      if (db.userDetails && db.userDetails[userId]) {
        name = db.userDetails[userId].fullName;
        username = db.userDetails[userId].username ? ` (@${db.userDetails[userId].username})` : '';
      }
      listMsg += `${index + 1}. ID: ${userId}${username} - NAME: ${name}\n`;
    });
  }

  await sendMonoReply(ctx, listMsg);
});

// Image Generation command
bot.command('imagine', async (ctx) => {
  const userId = ctx.from.id;
  const promptText = ctx.message.text.substring(9).trim(); // Remove "/imagine "

  if (!promptText) {
    return sendMonoReply(ctx, 'Please provide a prompt. Example:\n/imagine a beautiful mountain sunset');
  }

  // 1. Abuse Check
  if (isAbusive(promptText)) {
    return sendMonoReply(ctx, '❌ Request blocked: Your prompt contains restricted terms. Please keep prompts safe and appropriate.');
  }

  // 2. Length Check
  if (promptText.length > 300) {
    return sendMonoReply(ctx, '❌ Request blocked: The prompt must be under 300 characters.');
  }

  // 3. Rate Limit Check
  const delay = getRateLimitDelay(userId, 'generation');
  if (delay > 0) {
    return sendMonoReply(ctx, `⏱️ Please wait ${delay} seconds before generating another image.`);
  }

  const statusMsg = await sendMonoReply(ctx, '🎨 Generating image... Please wait...');

  try {
    const tempFileName = `temp_${Date.now()}.png`;
    console.log(`Generating image for prompt: "${promptText}"`);
    
    // Call Puter's txt2img using Grok Imagine
    await puter.ai.txt2img(promptText, {
      model: 'x-ai/grok-imagine-image-quality',
      puter_output_path: tempFileName
    });

    console.log(`Image saved to Puter filesystem as ${tempFileName}. Reading back...`);
    const file = await puter.fs.read(tempFileName);
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Send the generated photo
    console.log('Sending photo to Telegram...');
    await ctx.replyWithPhoto(
      { source: buffer },
      { 
        caption: `<blockquote><code>${toMonoCaps(`🎨 Imagine: ${promptText}`)}</code></blockquote>`, 
        parse_mode: 'HTML',
        reply_to_message_id: ctx.message.message_id
      }
    );

    // Clean up file in Puter cloud storage
    console.log('Cleaning up Puter temp file...');
    await puter.fs.delete(tempFileName);

    // Delete the status message
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
  } catch (error) {
    console.error('Error generating image:', error);
    await editMonoMessage(ctx, statusMsg.message_id, `❌ Error generating image: ${error.message}`);
  }
});

// Video Generation command (Animate)
bot.command('animate', async (ctx) => {
  if (!FAL_KEY || FAL_KEY === 'your_fal_api_key') {
    return sendMonoReply(ctx, '❌ Video generation is disabled because FAL_KEY is not configured in .env.');
  }

  const userId = ctx.from.id;
  const promptText = ctx.message.text.substring(9).trim(); // Remove "/animate "
  
  if (!promptText) {
    return sendMonoReply(ctx, 'Please provide a prompt. Example:\n/animate a drone flying through a cyberpunk street\n\nOr reply to a photo with /animate');
  }

  // 1. Abuse Check
  if (isAbusive(promptText)) {
    return sendMonoReply(ctx, '❌ Request blocked: Your prompt contains restricted terms. Please keep prompts safe and appropriate.');
  }

  // 2. Length Check
  if (promptText.length > 300) {
    return sendMonoReply(ctx, '❌ Request blocked: The prompt must be under 300 characters.');
  }

  // 3. Rate Limit Check
  const delay = getRateLimitDelay(userId, 'generation');
  if (delay > 0) {
    return sendMonoReply(ctx, `⏱️ Please wait ${delay} seconds before generating another video.`);
  }

  const statusMsg = await sendMonoReply(ctx, '🎥 Initializing video generation...');

  try {
    let imageUrl = null;

    // Check if the command is replying to a photo (Image-to-Video)
    if (ctx.message.reply_to_message && ctx.message.reply_to_message.photo) {
      console.log('Image-to-video mode detected. Downloading source image...');
      await editMonoMessage(ctx, statusMsg.message_id, '🎥 Downloading source photo...');
      
      const photoArray = ctx.message.reply_to_message.photo;
      // Get the highest resolution photo
      const fileId = photoArray[photoArray.length - 1].file_id;
      
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const response = await fetch(fileLink.href);
      const photoBuffer = Buffer.from(await response.arrayBuffer());

      // Create browser-compatible File object for Fal upload
      const fileObj = new File([photoBuffer], 'source_image.png', { type: 'image/png' });
      
      console.log('Uploading photo to Fal CDN...');
      await editMonoMessage(ctx, statusMsg.message_id, '🎥 Uploading photo to Fal CDN...');
      imageUrl = await fal.storage.upload(fileObj);
      console.log('Source image uploaded to Fal:', imageUrl);
    }

    console.log(`Starting Grok video generation with prompt: "${promptText}"`);
    await editMonoMessage(ctx, statusMsg.message_id, '🎥 Generating video (this takes about 30-60s)...');

    // Call Grok Aurora video engine on Fal.ai
    const inputPayload = {
      prompt: promptText,
      duration: 6,
      aspect_ratio: '16:9',
      resolution: '480p'
    };

    if (imageUrl) {
      inputPayload.image_url = imageUrl;
    }

    const result = await fal.subscribe('fal-ai/grok-imagine-video', {
      input: inputPayload,
      logs: true,
      onQueueUpdate: (update) => {
        console.log(`Fal status: ${update.status}`);
      }
    });

    const videoUrl = result.data.video.url;
    console.log('Video generated successfully! URL:', videoUrl);

    await editMonoMessage(ctx, statusMsg.message_id, '🎥 Sending video to Telegram...');

    // Send the video directly from URL
    await ctx.replyWithVideo(
      { url: videoUrl },
      { 
        caption: `<blockquote><code>${toMonoCaps(`🎥 Video Generated!\nPrompt: ${promptText}`)}</code></blockquote>`, 
        parse_mode: 'HTML',
        reply_to_message_id: ctx.message.message_id
      }
    );

    // Delete the status message
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
  } catch (error) {
    console.error('Error generating video:', error);
    await editMonoMessage(ctx, statusMsg.message_id, `❌ Error generating video: ${error.message}`);
  }
});

// Image / Photo analysis handler
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const photoArray = ctx.message.photo;
  const caption = ctx.message.caption || 'What is in this image?';
  const fileId = photoArray[photoArray.length - 1].file_id;

  // 1. Abuse Check
  if (isAbusive(caption)) {
    return sendMonoReply(ctx, '❌ Request blocked: Your message contains restricted terms.');
  }

  // 2. Length Check
  if (caption.length > 500) {
    return sendMonoReply(ctx, '❌ Request blocked: Caption must be under 500 characters.');
  }

  // 3. Rate Limit Check
  const delay = getRateLimitDelay(userId, 'chat');
  if (delay > 0) {
    return sendMonoReply(ctx, `⏱️ Rate limited. Please wait ${delay} seconds.`);
  }

  const statusMsg = await sendMonoReply(ctx, '🧐 Grok is analyzing the image...');

  try {
    console.log('Downloading image from Telegram for analysis...');
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(fileLink.href);
    const imageBuffer = Buffer.from(await response.arrayBuffer());

    // Convert to Base64 data URI format for Puter.js
    const mimeType = 'image/png';
    const base64Image = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;

    console.log('Sending vision request to Grok-2-Vision...');
    const result = await puter.ai.chat([
      {
        role: 'user',
        content: [
          { type: 'text', text: caption },
          { type: 'image_url', image_url: { url: base64Image } }
        ]
      }
    ], {
      model: 'x-ai/grok-2-vision'
    });

    const reply = result.message.content;
    
    // Reply to the user
    await sendMonoReply(ctx, reply, { reply_to_message_id: ctx.message.message_id });

    // Clean up status message
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
  } catch (error) {
    console.error('Error analyzing image:', error);
    await editMonoMessage(ctx, statusMsg.message_id, `❌ Error analyzing image: ${error.message}`);
  }
});

// General Text message handler
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const userText = ctx.message.text.trim();

  // Avoid handling command prefixes here
  if (userText.startsWith('/')) return;

  // 1. Abuse Check
  if (isAbusive(userText)) {
    return sendMonoReply(ctx, '❌ Your message contains terms that violate our safety policy. Please be respectful.');
  }

  // 2. Length Check
  if (userText.length > 1000) {
    return sendMonoReply(ctx, '❌ Message is too long. Please keep it under 1000 characters.');
  }

  // 3. Rate Limit Check
  const delay = getRateLimitDelay(userId, 'chat');
  if (delay > 0) {
    return sendMonoReply(ctx, `⏱️ Rate limited. Please wait ${delay} seconds.`);
  }

  // Set typing status
  await ctx.sendChatAction('typing');

  try {
    console.log(`User ${userId}: "${userText}"`);

    // Prepare conversational history
    updateHistory(userId, 'user', userText);

    // Build the payload
    const messages = conversationHistory[userId];

    // Call Puter.js Grok Chat API
    const result = await puter.ai.chat(messages, {
      model: 'x-ai/grok-4-1-fast'
    });

    const reply = result.message.content;

    // Save assistant response to memory
    updateHistory(userId, 'assistant', reply);

    // Send reply to user
    await sendMonoReply(ctx, reply, { reply_to_message_id: ctx.message.message_id });
  } catch (error) {
    console.error('Error processing chat:', error);
    await sendMonoReply(ctx, `❌ Error processing chat: ${error.message}`);
  }
});

// Start the bot
console.log('Connecting bot to Telegram...');
bot.launch()
  .then(() => {
    console.log('🚀 Telegram Bot is running successfully!');
  })
  .catch((err) => {
    console.error('❌ Failed to launch Telegram Bot:', err);
  });

// Simple HTTP server for Render health checks
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('xAI Telegram Bot is active and running!\n');
}).listen(PORT, () => {
  console.log(`Web health-check server listening on port ${PORT}`);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
