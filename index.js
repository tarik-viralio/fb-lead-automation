require('dotenv').config({ path: './.env' });
console.log("TOKEN DEBUG:", process.env.FB_ACCESS_TOKEN);
const axios = require('axios');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PROCESSED_FILE = path.join(__dirname, 'processed_leads.json');
const FB_API = 'https://graph.facebook.com/v19.0';

// Standard field names Facebook uses in Lead Ads forms
const STANDARD_FIELDS = new Set([
  'full_name', 'first_name', 'last_name',
  'email', 'phone_number', 'phone',
]);

// ---------------------------------------------------------------------------
// Processed leads store (deduplication)
// ---------------------------------------------------------------------------
function loadProcessed() {
  if (!fs.existsSync(PROCESSED_FILE)) {
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify({ ids: [] }, null, 2));
  }
  try {
    return JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'));
  } catch {
    return { ids: [] };
  }
}

function markProcessed(id) {
  const store = loadProcessed();
  if (!store.ids.includes(id)) {
    store.ids.push(id);
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify(store, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Facebook Graph API
// ---------------------------------------------------------------------------
async function fetchLeads() {
  const allLeads = [];
  let url = `${FB_API}/${process.env.FB_FORM_ID}/leads`;
  let params = {
    access_token: process.env.FB_ACCESS_TOKEN,
    fields: 'id,created_time,field_data',
    limit: 100,
  };

  // Handle pagination so we never miss leads
  while (url) {
    const { data } = await axios.get(url, { params });
    allLeads.push(...(data.data || []));

    // Only follow next page on first iteration (params already in cursor)
    url = data.paging?.next || null;
    params = {};  // cursor is embedded in the next URL
  }

  return allLeads;
}

function normalizeFieldName(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseLead(raw) {
  const fields = {};
  for (const { name, values } of raw.field_data || []) {
    fields[name] = (values || [])[0] || '';
  }

  function parseLeadFields(fieldData = []) {
  const parsed = {
    name: null,
    email: null,
    phone: null,
    additionalInfo: [],
  };

  for (const field of fieldData) {
    const rawName = field.name || '';
    const normalized = normalizeFieldName(rawName);
    const value = Array.isArray(field.values) ? field.values.join(', ') : '';

    if (!value) continue;

    if (
      [
        'full_name',
        'vollstandiger_name',
        'vollstaendiger_name',
        'name',
      ].includes(normalized)
    ) {
      parsed.name = value;
      continue;
    }

    if (
      [
        'email',
        'e_mail',
        'email_adresse',
        'e_mail_adresse',
      ].includes(normalized)
    ) {
      parsed.email = value;
      continue;
    }

    if (
      [
        'phone',
        'phone_number',
        'telefon',
        'telefonnummer',
        'mobilnummer',
        'handynummer',
      ].includes(normalized)
    ) {
      parsed.phone = value;
      continue;
    }

    parsed.additionalInfo.push(`${rawName}: ${value}`);
  }

  return {
    name: parsed.name || 'Unknown',
    email: parsed.email || 'N/A',
    phone: parsed.phone || 'N/A',
    additionalInfo: parsed.additionalInfo.join('\n'),
  };
}

  const name =
    fields['full_name'] ||
    [fields['first_name'], fields['last_name']].filter(Boolean).join(' ') ||
    'Unknown';

  const phone = fields['phone_number'] || fields['phone'] || '';
  const email = fields['email'] || '';

  // Everything that isn't a standard field becomes "additional info"
  const extras = Object.entries(fields)
    .filter(([k]) => !STANDARD_FIELDS.has(k))
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  return { id: raw.id, created_time: raw.created_time, name, email, phone, extras };
}

// ---------------------------------------------------------------------------
// Gmail SMTP
// ---------------------------------------------------------------------------
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

async function sendEmail(lead) {
  const body = [
    'Moin,',
    '',
    'Du hast nen neuen LEAD von FB Ads.',
    '',
    `Name: ${lead.name}`,
    `Email: ${lead.email || 'N/A'}`,
    `Telefon: ${lead.phone || 'N/A'}`,
    `Additional Info: ${lead.extras || 'N/A'}`,
    '',
    'Viel Erfolg 🔥',
  ].join('\n');

  await transporter.sendMail({
    from: `"FB Lead Bot" <${process.env.GMAIL_USER}>`,
    to: process.env.NOTIFY_EMAIL,
    subject: '🚀 New FB Lead',
    text: body,
  });
}

// ---------------------------------------------------------------------------
// Close CRM API
// ---------------------------------------------------------------------------
async function createCloseLead(lead) {
  const payload = {
    name: lead.name,
    status_label: 'Warm',
    contacts: [
      {
        name: lead.name,
        ...(lead.email && { emails: [{ email: lead.email, type: 'office' }] }),
        ...(lead.phone && { phones: [{ phone: lead.phone, type: 'office' }] }),
      },
    ],
  };

  await axios.post('https://api.close.com/api/v1/lead/', payload, {
    auth: { username: process.env.CLOSE_API_KEY, password: '' },
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function validateEnv() {
  const required = [
    'FB_ACCESS_TOKEN', 'FB_FORM_ID',
    'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'NOTIFY_EMAIL',
    'CLOSE_API_KEY',
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('Missing environment variables:', missing.join(', '));
    process.exit(1);
  }
}

async function run() {
  console.log(`[${new Date().toISOString()}] Checking for new leads...`);

  const processed = loadProcessed();

  let rawLeads;
  try {
    rawLeads = await fetchLeads();
  } catch (err) {
    console.error('Failed to fetch Facebook leads:', err.response?.data || err.message);
    return;
  }

  const newLeads = rawLeads
    .map(parseLead)
    .filter((l) => !processed.ids.includes(l.id));

  if (newLeads.length === 0) {
    console.log('No new leads.');
    return;
  }

  console.log(`Found ${newLeads.length} new lead(s).`);

  for (const lead of newLeads) {
    console.log(`  → Processing: ${lead.name} [${lead.id}]`);

    try {
      await sendEmail(lead);
      console.log('    ✓ Email sent');
    } catch (err) {
      console.error('    ✗ Email failed:', err.message);
    }

    try {
      await createCloseLead(lead);
      console.log('    ✓ Close CRM lead created');
    } catch (err) {
      const detail = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      console.error('    ✗ Close CRM failed:', detail);
    }

    // Mark as processed even if one step failed,
    // to avoid sending duplicate emails/CRM entries on retry.
    markProcessed(lead.id);
  }
}

validateEnv();
run();
