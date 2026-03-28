require('dotenv').config({ path: './.env' });
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
// const STANDARD_FIELDS = new Set([
//  'full_name', 'first_name', 'last_name',
//  'email', 'phone_number', 'phone',
// ]);

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

function parseLeadFields(fieldData = []) {
  const parsed = {
    name: null,
    email: null,
    phone: null,
    patientCount: null,
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

    if (
      [
        'wie_viele_patienten_haben_sie_pro_monat',
        'patienten_pro_monat',
      ].includes(normalized)
    ) {
      parsed.patientCount = value;
      continue;
    }

    parsed.additionalInfo.push(`${rawName}: ${value}`);
  }

  return {
  name: parsed.name || 'Unknown',
  email: parsed.email || '',
  phone: parsed.phone || '',
  patientCount: parsed.patientCount || 'N/A',
  additionalInfo: parsed.additionalInfo.join('\n'),
};
}

function parseLead(raw) {
  const parsed = parseLeadFields(raw.field_data || []);

  return {
    id: raw.id,
    created_time: raw.created_time,
    name: parsed.name,
    email: parsed.email,
    phone: parsed.phone,
    patientCount: parsed.patientCount,
    extras: parsed.additionalInfo,
  };
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
    'Moin Boss,',
    '',
    'Du hast nen neuen LEAD von FB Ads.',
    '',
    `Name: ${lead.name}`,
    `E-Mail: ${lead.email || 'N/A'}`,
    `Tel.-Nummer: ${lead.phone || 'N/A'}`,
    `Patienten pro Monat: ${lead.patientCount || 'N/A'}`,
    '',
    'Viel Erfolg 🔥',
  ].join('\n');

  await transporter.sendMail({
    from: `"Viralio" <${process.env.GMAIL_USER}>`,
    to: process.env.NOTIFY_EMAIL,
    subject: '💸New FB LEAD🚀',
    text: body,
  });
}

// ---------------------------------------------------------------------------
// Close CRM API
// ---------------------------------------------------------------------------

// Normalize a display name for fuzzy-matching against Close CRM.
// Same logic as normalizeFieldName so comparisons are consistent.
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Search Close CRM for a lead that matches by email, phone, or (fallback) name.
 * Returns true if a duplicate is found, false otherwise.
 */
async function existsInClose(lead) {
  const closeAuth = { username: process.env.CLOSE_API_KEY, password: '' };
  const baseUrl = 'https://api.close.com/api/v1';

  // Helper: run a Close search query and return all matching leads
  async function searchClose(query) {
    const { data } = await axios.get(`${baseUrl}/lead/`, {
      auth: closeAuth,
      params: { query, _fields: 'id,contacts', _limit: 10 },
    });
    return data.data || [];
  }

  // 1. Match by email
  if (lead.email) {
    const results = await searchClose(`email:"${lead.email}"`);
    if (results.length > 0) {
      console.log(`    ~ Duplicate found in Close by email: ${lead.email}`);
      return true;
    }
  }

  // 2. Match by phone
  if (lead.phone) {
    // Strip non-digit chars for comparison
    const digitsOnly = lead.phone.replace(/\D/g, '');
    const results = await searchClose(`phone:"${lead.phone}"`);
    if (results.length > 0) {
      console.log(`    ~ Duplicate found in Close by phone: ${lead.phone}`);
      return true;
    }
    // Also try digits-only variant if different from original
    if (digitsOnly !== lead.phone) {
      const results2 = await searchClose(`phone:"${digitsOnly}"`);
      if (results2.length > 0) {
        console.log(`    ~ Duplicate found in Close by phone (digits): ${digitsOnly}`);
        return true;
      }
    }
  }

  // 3. Fallback: match by normalized name (only when both email and phone are absent)
  if (!lead.email && !lead.phone && lead.name && lead.name !== 'Unknown') {
    const results = await searchClose(`name:"${lead.name}"`);
    const normalizedIncoming = normalizeName(lead.name);
    for (const r of results) {
      if (normalizeName(r.name) === normalizedIncoming) {
        console.log(`    ~ Duplicate found in Close by name: ${lead.name}`);
        return true;
      }
    }
  }

  return false;
}

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

    // Check Close CRM for duplicates before doing anything
    let duplicate = false;
    try {
      duplicate = await existsInClose(lead);
    } catch (err) {
      console.error('    ✗ Close duplicate check failed:', err.response?.data || err.message);
      // Treat as non-duplicate so we don't silently drop the lead
    }

    if (duplicate) {
      console.log('    ⊘ Skipped — already exists in Close CRM');
      markProcessed(lead.id);
      continue;
    }

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

    markProcessed(lead.id);
  }
}

validateEnv();
run();
