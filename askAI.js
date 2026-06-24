require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || 'sk-or-v1-key';
const SCRAPINGDOG_KEY = process.env.SCRAPINGDOG_KEY || 'key';
// Console-first: the full result is printed to stdout. A file is written ONLY
// if you explicitly set OUTPUT_FILE, e.g. OUTPUT_FILE=result.json node askAI.js
const OUTPUT_FILE = process.env.OUTPUT_FILE || null;

const SCENARIO = Number(process.env.SCENARIO || 2);
// The LinkedIn Profile API is the ground-truth source for the experience section.
// It was being called with a 1s timeout (so it ALWAYS failed and experience was
// rebuilt from less-accurate web research). Give it a real timeout so the scraped
// profile is used when available. fresh=false uses Scrapingdog's cached scrape
// (faster, same fields); set LINKEDIN_FRESH=true to force a live re-scrape.
// A successful cached profile fetch returns in ~1-3s; if it takes much longer it
// is hanging and will likely fail, so cap it tight to bound the worst case.
const LINKEDIN_TIMEOUT_MS = Number(process.env.LINKEDIN_TIMEOUT_MS || 12000);
const LINKEDIN_FRESH = process.env.LINKEDIN_FRESH === 'true';
// Scrapingdog's standard scrape fails on some profiles with a 400
// "Something went wrong. Try again or use premium=true." Many real profiles
// (e.g. ones behind tougher anti-bot protection) only resolve with premium
// proxies. 'auto' (default) tries standard first, then retries with premium on
// failure — recovers those profiles while keeping the cheap path for the rest.
// LINKEDIN_PREMIUM=always forces premium up-front; =never disables it.
const LINKEDIN_PREMIUM = (process.env.LINKEDIN_PREMIUM || 'auto').toLowerCase();
// How many times to attempt the premium scrape before giving up. Premium is the
// reliable path, so a few retries with backoff make profile resolution robust
// against one-off provider/network blips (the cause of sporadic profile_not_found).
const LINKEDIN_PREMIUM_RETRIES = Number(process.env.LINKEDIN_PREMIUM_RETRIES || 3);
// A no-anchor profile (no company from the API) with at least this many
// followers is treated as a public figure whose career research is reliable, so
// we still research it. Below this, a no-anchor profile is deemed unverifiable
// (same-name risk) and we skip research + return baseline only.
const PROMINENCE_FOLLOWERS = Number(process.env.PROMINENCE_FOLLOWERS || 10000);
// Retry off by default: a retry on a hanging profile just doubles the wait
// (12s -> 24s) and rarely recovers. Set LINKEDIN_PROFILE_RETRIES=1 if you prefer
// resilience over speed.
const LINKEDIN_PROFILE_RETRIES = Number(
  process.env.LINKEDIN_PROFILE_RETRIES || 0
);
const LINKEDIN_PROFILE_FALLBACK =
  process.env.LINKEDIN_PROFILE_FALLBACK !== 'false';
const PRIVATE_PROFILE_OPENAI_FALLBACK =
  process.env.PRIVATE_PROFILE_OPENAI_FALLBACK === 'true';
const PRIVATE_PROFILE_USE_PAID_WEB_FALLBACK =
  process.env.PRIVATE_PROFILE_USE_PAID_WEB_FALLBACK === 'true';
const PRIVATE_PROFILE_FOLLOWUPS =
  process.env.PRIVATE_PROFILE_FOLLOWUPS === 'true';
const PRIVATE_PROFILE_RESCUE =
  process.env.PRIVATE_PROFILE_RESCUE === 'true';
const LOW_EVIDENCE_BASELINE_ONLY_MAX = Number(
  process.env.LOW_EVIDENCE_BASELINE_ONLY_MAX || 1
);

// Experience is the money field. Keep this on for LinkedIn enrichment.
const EXPERIENCE_FIRST = process.env.EXPERIENCE_FIRST !== 'false';

// "off"      -> no live research, only normalize/synthesize supplied data
// "standard" -> focused experience research with provider fallbacks
// "deep"     -> standard research plus per-company and alternate-anchor queries
const RESEARCH_MODE = process.env.RESEARCH_MODE || 'standard';

const SEARCH_FALLBACK = process.env.SEARCH_FALLBACK || 'perplexity';
const PERPLEXITY_SEARCH_MODEL =
  process.env.PERPLEXITY_SEARCH_MODEL || 'perplexity/sonar';
const OPENROUTER_SEARCH_MODEL =
  process.env.OPENROUTER_SEARCH_MODEL || 'openai/gpt-4o-mini-search-preview';
const PRIVATE_PROFILE_MODEL =
  process.env.PRIVATE_PROFILE_MODEL || 'openai/gpt-4o-mini-search-preview';
const AI_MODE_MAX_CALLS = Number(
  process.env.AI_MODE_MAX_CALLS || (RESEARCH_MODE === 'off' ? 0 : -1)
);
const AI_MODE_CONCURRENCY = Number(process.env.AI_MODE_CONCURRENCY || 10);
// All AI Mode queries fire in one concurrent wave, so the research phase's
// wall-clock = the SLOWEST single call. Retries are off and the per-call timeout
// is capped so one slow/hanging call can no longer balloon the whole run (that
// was the 23s-vs-56s swing). A dropped slow call costs at most one query out of
// ~8; synthesis (the source of the rich about text) is untouched.
const AI_MODE_RETRIES = Number(process.env.AI_MODE_RETRIES || 0);
const AI_MODE_RETRY_DELAY_MS = Number(
  process.env.AI_MODE_RETRY_DELAY_MS || 800
);
const AI_MODE_TIMEOUT_MS = Number(process.env.AI_MODE_TIMEOUT_MS || 18000);
// The paid web-search fallback (Perplexity/OpenRouter) fires after the AI Mode
// wave when results look weak, and it ran with a 90s timeout -> the occasional
// 35s+ research spike. Cap it so it can never blow the time budget.
const SEARCH_FALLBACK_TIMEOUT_MS = Number(
  process.env.SEARCH_FALLBACK_TIMEOUT_MS || 15000
);
const AI_MODE_MAX_QUERY_CHARS = Number(
  process.env.AI_MODE_MAX_QUERY_CHARS || 900
);
const PERPLEXITY_BATCH_MODE = process.env.PERPLEXITY_BATCH_MODE !== 'false';
const PERPLEXITY_BATCH_SIZE = Number(
  process.env.PERPLEXITY_BATCH_SIZE || (RESEARCH_MODE === 'deep' ? 6 : 8)
);
const EXPERIENCE_FOLLOWUP_LIMIT = Number(
  process.env.EXPERIENCE_FOLLOWUP_LIMIT || (RESEARCH_MODE === 'deep' ? 12 : 8)
);
// Auto-trigger the follow-up experience pass when LinkedIn API returned fewer
// than this many roles. LinkedIn hides older roles behind sign-in, so a sparse
// baseline (e.g. 3-5 roles for someone with 15+ companies) is the signal that
// there are hidden roles to recover. Set to 0 to disable auto-trigger.
const EXPERIENCE_FOLLOWUP_SPARSE_THRESHOLD = Number(
  process.env.EXPERIENCE_FOLLOWUP_SPARSE_THRESHOLD || 6
);
// The experience rescue runs a full extra research + re-synthesis round when a
// profile has few roles - the main cause of 40-50s spikes. Accurate experience
// already comes from the real profile, so rescue is off by default for speed.
// Set EXPERIENCE_RESCUE_ENABLED=true to re-enable hunting for hidden older roles.
const EXPERIENCE_RESCUE_ENABLED = process.env.EXPERIENCE_RESCUE_ENABLED === 'true';
const RESCUE_MIN_EXPERIENCE_COUNT = Number(
  process.env.RESCUE_MIN_EXPERIENCE_COUNT || 5
);
const RESCUE_SEARCH_MODEL =
  process.env.RESCUE_SEARCH_MODEL || 'perplexity/sonar';
const RESCUE_CONTEXT_CHARS = Number(process.env.RESCUE_CONTEXT_CHARS || 3500);
const RESCUE_FIELD_CHARS = Number(process.env.RESCUE_FIELD_CHARS || 500);
// Company LinkedIn-ID resolution costs a full extra AI Mode call + an LLM parse
// (~15-18s) just to fill experience[].company_linkedin_id — it does NOT add the
// about text / descriptions / references. Off by default so it never sits on the
// critical path. Set COMPANY_ID_LOOKUP_ENABLED=true if you specifically need the
// company LinkedIn IDs.
const COMPANY_ID_LOOKUP_ENABLED =
  process.env.COMPANY_ID_LOOKUP_ENABLED === 'true';
const COMPANY_ID_LOOKUP_LIMIT = Number(process.env.COMPANY_ID_LOOKUP_LIMIT || 8);

// AI Mode is an internal product, so public contact research is enabled by
// default. Set INCLUDE_CONTACT=false when a product tier does not need it.
const INCLUDE_CONTACT = process.env.INCLUDE_CONTACT !== 'false';

function envList(name, fallback) {
  return (process.env[name] || fallback)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function openRouterModelOptions(model) {
  if (model.startsWith('nousresearch/hermes-4-')) {
    return {
      // Hermes 4 is a hybrid reasoning model. Disable reasoning here because
      // planner/synthesis tasks need strict JSON, not long chain output.
      reasoning: { enabled: false },
    };
  }

  return {};
}

// Cheap structured-output models. Escalation is used only if validation fails.
// Fast-first cascade for a reliable sub-30s synthesis. gemini-2.5-flash-lite is
// fast (~5-16s) and consistent; hermes/gpt-4o-mini are validation fallbacks. The
// fast model can be lossy with experience descriptions / about text, so
// preserveBaselineData() deterministically restores those from the real LinkedIn
// profile after synthesis -> accurate experience is guaranteed regardless of model.
const SYNTHESIS_MODELS = envList(
  'SYNTHESIS_MODELS',
  'google/gemini-2.5-flash-lite,openai/gpt-4o-mini,nousresearch/hermes-4-70b'
);

const PLANNER_MODELS = envList(
  'PLANNER_MODELS',
  'nousresearch/hermes-4-70b,google/gemini-2.5-flash-lite,openai/gpt-4o-mini'
);

const MAX_ACTIVITIES = Number(process.env.MAX_ACTIVITIES || 8);
const MAX_ACTIVITY_CHARS = Number(process.env.MAX_ACTIVITY_CHARS || 500);
const MAX_RESEARCH_CHARS = Number(process.env.MAX_RESEARCH_CHARS || 10000);
// Cap how many experience rows the synthesis model must (re)generate. The real
// profile's full experience is restored deterministically afterward, so the model
// only needs to handle the most recent roles (descriptions/about). This bounds
// synthesis output/latency on rich profiles (e.g. 29 roles) without losing any
// roles in the final result.
const SYNTHESIS_EXPERIENCE_LIMIT = Number(
  process.env.SYNTHESIS_EXPERIENCE_LIMIT || 12
);
// Synthesis latency scales with input size. Now that the real profile supplies
// the accurate experience, research mainly adds the about text + a little
// context, so it does not need to be huge. ~35k chars (~9k tokens) keeps the
// about rich while making hermes synthesis faster and far less variable.
const MAX_TOTAL_RESEARCH_CHARS = Number(
  process.env.MAX_TOTAL_RESEARCH_CHARS || 35000
);

const METRICS = {
  openrouter_calls: 0,
  openrouter_cost: 0,
  perplexity_search_calls: 0,
  openrouter_search_calls: 0,
  scrapingdog_ai_calls: 0,
  scrapingdog_ai_failures: 0,
  linkedin_api_calls: 0,
  linkedin_api_failures: 0,
};

const EXISTING_PROFILE = {
  name: process.env.EXISTING_NAME || 'Darshan Khandelwal',
  title: process.env.EXISTING_TITLE || 'Co-Founder',
  company: process.env.EXISTING_COMPANY || 'Scrapingdog',
  location: process.env.EXISTING_LOCATION || 'Jaipur, India',
};

const LINKEDIN_URL =
  process.env.LINKEDIN_URL ||
  'https://www.linkedin.com/in/shravantickoo/';

const FIRST_NAME = process.env.FIRST_NAME || 'Elon';
const LAST_NAME = process.env.LAST_NAME || 'Musk';
const COMPANY_NAME = process.env.COMPANY_NAME || 'Tesla';

// ---------------------------------------------------------------------------
// OUTPUT SCHEMA
// ---------------------------------------------------------------------------
const nullableString = { type: ['string', 'null'] };
const stringArray = { type: 'array', items: { type: 'string' } };

const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: nullableString,
    first_name: nullableString,
    last_name: nullableString,
    headline: nullableString,
    current_company: nullableString,
    current_role: nullableString,
    location: nullableString,
    linkedin_url: nullableString,
    social_links: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          platform: nullableString,
          url: nullableString,
          handle: nullableString,
        },
        required: ['platform', 'url', 'handle'],
      },
    },
    website: nullableString,
    email: nullableString,
    phone: nullableString,
    about: nullableString,
    skills: stringArray,
    languages: stringArray,
    education: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          institution: nullableString,
          degree: nullableString,
          field: nullableString,
          start_year: { type: ['integer', 'null'] },
          end_year: { type: ['integer', 'null'] },
        },
        required: [
          'institution',
          'degree',
          'field',
          'start_year',
          'end_year',
        ],
      },
    },
    experience: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          company: nullableString,
          title: nullableString,
          location: nullableString,
          start_date: nullableString,
          end_date: nullableString,
          description: nullableString,
          company_url: nullableString,
          company_linkedin_id: nullableString,
        },
        required: [
          'company',
          'title',
          'location',
          'start_date',
          'end_date',
          'description',
          'company_url',
          'company_linkedin_id',
        ],
      },
    },
    certifications: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: nullableString,
          issuer: nullableString,
          year: { type: ['integer', 'null'] },
        },
        required: ['name', 'issuer', 'year'],
      },
    },
    awards: stringArray,
    publications: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: nullableString,
          url: nullableString,
          platform: nullableString,
          date: nullableString,
        },
        required: ['title', 'url', 'platform', 'date'],
      },
    },
    volunteer: stringArray,
    connections: nullableString,
    followers: nullableString,
    is_open_to_work: { type: 'boolean' },
    is_hiring: { type: 'boolean' },
    company_size: nullableString,
    company_industry: nullableString,
    company_founded: nullableString,
    company_website: nullableString,
    company_linkedin_url: nullableString,
    investment_activity: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: nullableString,
          amount: nullableString,
          date: nullableString,
        },
        required: ['description', 'amount', 'date'],
      },
    },
    confidence_score: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
    },
    data_source: {
      type: 'string',
      enum: ['scraped', 'ai_knowledge', 'enriched'],
    },
    missing_fields: stringArray,
  },
  required: [
    'name',
    'first_name',
    'last_name',
    'headline',
    'current_company',
    'current_role',
    'location',
    'linkedin_url',
    'social_links',
    'website',
    'email',
    'phone',
    'about',
    'skills',
    'languages',
    'education',
    'experience',
    'certifications',
    'awards',
    'publications',
    'volunteer',
    'connections',
    'followers',
    'is_open_to_work',
    'is_hiring',
    'company_size',
    'company_industry',
    'company_founded',
    'company_website',
    'company_linkedin_url',
    'investment_activity',
    'confidence_score',
    'data_source',
    'missing_fields',
  ],
};

const EXPERIENCE_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    likely_missing_roles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          company: nullableString,
          title_hint: nullableString,
          date_hint: nullableString,
          reason: nullableString,
        },
        required: ['company', 'title_hint', 'date_hint', 'reason'],
      },
    },
    follow_up_queries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          query: { type: 'string' },
        },
        required: ['label', 'query'],
      },
    },
  },
  required: ['likely_missing_roles', 'follow_up_queries'],
};

// Laser-focused company enumeration. Runs in parallel with full synthesis and
// is prompted to do ONE thing well: list every employer clearly attributable to
// the exact person. Catches companies the broader synthesis pass drops.
const EXPERIENCE_EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    companies: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          company: nullableString,
          title: nullableString,
          start_date: nullableString,
          end_date: nullableString,
          location: nullableString,
          description: nullableString,
          attribution_confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
          },
        },
        required: [
          'company',
          'title',
          'start_date',
          'end_date',
          'location',
          'description',
          'attribution_confidence',
        ],
      },
    },
  },
  required: ['companies'],
};

const PRIVATE_PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    exact_identity_match: { type: 'boolean' },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low', 'not_found'],
    },
    answer: { type: 'string' },
    warnings: stringArray,
  },
  required: ['exact_identity_match', 'confidence', 'answer', 'warnings'],
};

const COMPANY_ID_LOOKUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    companies: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          company: nullableString,
          linkedin_url: nullableString,
          linkedin_id: nullableString,
          confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low', 'not_found'],
          },
          source_url: nullableString,
        },
        required: [
          'company',
          'linkedin_url',
          'linkedin_id',
          'confidence',
          'source_url',
        ],
      },
    },
  },
  required: ['companies'],
};

const SYSTEM_PROMPT = `
You are a professional profile enrichment engine.

Evidence order:
1. Supplied structured profile data
2. Live research with source URLs
3. Conservative inference from role and company context

Accuracy rules:
- Never overwrite supplied facts with weaker evidence.
- Never invent an employer, employment date, degree, email, phone, URL, award,
  publication, follower count, or company fact.
- Never turn weak hints into experience records. Experience requires at least a
  verified company and verified title.
- Never use "likely/probably/may have" language in the final JSON.
- A fact about a person with the same name is not evidence. Match company,
  location, LinkedIn URL, or another unique identifier.
- Inferred skills are allowed when strongly implied by verified work, but do not
  present inferred dates, contact details, or work history as facts.
- Use null or [] when evidence is absent.
- Keep "about" factual and useful. Do not add promotional language.
- Set high confidence only when core identity and current role are verified.
- List every null or empty-array field in missing_fields.
- Return only data matching the requested JSON schema.
`.trim();

const EXPERIENCE_SYSTEM_PROMPT = `
You are a forensic career-history analyst.

Your only important job is reconstructing the most complete verified experience
section possible. Public LinkedIn often hides old roles behind sign-in walls, so
you must merge weak public fragments, AI Mode search summaries, snippets,
company biographies, archived bios, speaker pages, articles, podcasts, and
search-result references into one accurate work-history timeline.

Rules:
- Scraped LinkedIn experience is ground truth for roles it contains.
- Add missing roles only when evidence ties the role to the same person through
  LinkedIn URL, company, location, biography context, exact title, or timeline.
- It is okay to use "company + title exists, dates unknown" when company/title
  are verified but dates are not.
- Never add a name-only match.
- Never invent dates. Keep start_date or end_date null when not proven.
- If multiple source snippets disagree, prefer the more specific source and
  mention uncertainty in the role description.
- The final experience array must be ordered newest to oldest.
`.trim();

// ---------------------------------------------------------------------------
// DATA REDUCTION
// ---------------------------------------------------------------------------
function firstObject(value) {
  return Array.isArray(value) ? value[0] || {} : value || {};
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function trimText(value, maxChars) {
  if (value === null || value === undefined) return value;
  const text = String(value).trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function normalizeLinkedInCompanyUrl(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const companyMatch = raw.match(
    /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/([^/?#]+)/i
  );
  if (companyMatch) {
    return `https://www.linkedin.com/company/${companyMatch[1]}`;
  }

  const schoolMatch = raw.match(
    /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/school\/([^/?#]+)/i
  );
  if (schoolMatch) {
    return `https://www.linkedin.com/school/${schoolMatch[1]}`;
  }

  // Reject person profile URLs — /in/ is a person, not a company page.
  if (/linkedin\.com\/in\//i.test(raw)) return null;

  return raw;
}

function extractLinkedInCompanyId(value) {
  const normalized = normalizeLinkedInCompanyUrl(value);
  if (!normalized) return null;

  const match = normalized.match(/linkedin\.com\/(?:company|school)\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]).replace(/\/$/, '') : null;
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') || null;
}

// Collapse newlines and repeated spaces into single spaces (LinkedIn scrapes are
// full of ragged whitespace). Returns null for empty/blank input.
function tidyText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value)
    // Normalize unicode hyphen/dash variants to ASCII so compound words like
    // "Full‑Stack" / "location‑aware" render consistently everywhere. A soft
    // hyphen (U+00AD) between letters is the model's intent for a real hyphen.
    .replace(/(?<=\w)­(?=\w)/g, '-')
    .replace(/­/g, '')
    .replace(/[‐‑‒–]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

// LinkedIn experience scrapes pack the role and company into one field separated
// by a block of line breaks: "Position\n\n\nCompany". Fixes "position and company
// in the same field" by splitting on the line breaks and taking the company
// segment (independent of whether the job title matches), with a fallback that
// strips a duplicated title prefix from an already-collapsed single string.
function cleanCompanyName(rawCompany, title) {
  if (rawCompany === null || rawCompany === undefined) return null;

  // The line breaks are the real separator. Split on them, tidy each piece, and
  // take the LAST non-empty segment — that is the company name.
  const segments = String(rawCompany)
    .split(/[\r\n]+/)
    .map((segment) => segment.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  let company = segments.length
    ? segments[segments.length - 1]
    : tidyText(rawCompany);
  if (!company) return null;

  // Fallback: an already-collapsed single string that still begins with the job
  // title (e.g. "Chairman and CEO Microsoft" with no line breaks left).
  const cleanTitle = tidyText(title);
  if (
    cleanTitle &&
    company.length > cleanTitle.length &&
    company.toLowerCase().startsWith(cleanTitle.toLowerCase())
  ) {
    const stripped = company
      .slice(cleanTitle.length)
      .replace(/^[\s·,\-–|/@]+/, '')
      .trim();
    if (stripped) company = stripped;
  }
  return company || null;
}

function compactProfile(rawProfile, linkedinUrl = '') {
  const profile = firstObject(rawProfile);
  const experience = Array.isArray(profile.experience)
    ? profile.experience
    : [];
  const education = Array.isArray(profile.education) ? profile.education : [];
  const activities = Array.isArray(profile.activities) ? profile.activities : [];

  const compactExperience = dedupeBy(
    experience.map((item) => {
      const companyUrl = normalizeLinkedInCompanyUrl(
        firstPresent(
          item.company_linkedin_url,
          item.company_url,
          item.companyUrl,
          item.company_link,
          item.url
        )
      );

      const rawTitle = item.position || item.title || item.role || null;
      const rawCompany =
        item.company_name ||
        item.company ||
        item.companyName ||
        item.organization ||
        null;

      return {
        company: cleanCompanyName(rawCompany, rawTitle),
        title: tidyText(rawTitle),
        location: tidyText(item.location),
        start_date:
          item.start_date || item.starts_at || item.startDate || null,
        end_date: item.end_date || item.ends_at || item.endDate || null,
        duration: item.duration || null,
        description: trimText(item.description || item.summary || null, 1000),
        company_url: companyUrl,
        company_linkedin_id:
          firstPresent(
            item.company_linkedin_id,
            item.company_id,
            item.company_public_id,
            item.company_public_identifier
          ) || extractLinkedInCompanyId(companyUrl),
      };
    }),
    (item) =>
      `${item.company || ''}|${item.title || ''}|${item.start_date || ''}`
        .toLowerCase()
  );

  const compactEducation = dedupeBy(
    education.map((item) => ({
      institution:
        item.school_name ||
        item.institution ||
        item.school ||
        item.name ||
        null,
      degree: item.degree || item.degree_name || null,
      field: item.field || item.field_of_study || null,
      start_year: item.start_year || item.starts_at || null,
      end_year: item.end_year || item.ends_at || null,
    })),
    (item) =>
      `${item.institution || ''}|${item.degree || ''}|${item.end_year || ''}`
        .toLowerCase()
  );

  const activityDigest = activities
    .slice(0, MAX_ACTIVITIES)
    .map((item) => ({
      type: item.activity_type || item.type || null,
      text: trimText(
        item.post_text || item.text || item.description || '',
        MAX_ACTIVITY_CHARS
      ),
      link: item.link || item.url || null,
      date: item.date || item.posted_at || null,
    }))
    .filter((item) => item.text);

  const profileId = profile.public_identifier || profile.publicIdentifier;

  return {
    profile_source: 'linkedin_api',
    name: profile.fullName || profile.full_name || profile.name || null,
    headline: profile.headline || profile.title || null,
    location: profile.location || null,
    linkedin_url:
      linkedinUrl ||
      profile.linkedin_url ||
      (profileId ? `https://www.linkedin.com/in/${profileId}` : null),
    about: trimText(profile.about || profile.summary || null, 2500),
    followers: profile.followers || null,
    connections: profile.connections || null,
    is_open_to_work:
      profile.is_open_to_work === true || profile.open_to_work === true,
    is_hiring: profile.is_hiring === true || profile.hiring === true,
    website:
      profile.website ||
      profile.description?.website ||
      profile.description?.link ||
      null,
    email: profile.email || null,
    phone: profile.phone || null,
    social_links: Array.isArray(profile.social_links)
      ? profile.social_links.slice(0, 20)
      : [],
    experience: compactExperience,
    education: compactEducation,
    skills: Array.isArray(profile.skills) ? profile.skills.slice(0, 30) : [],
    languages: Array.isArray(profile.languages)
      ? profile.languages.slice(0, 20)
      : [],
    certifications: Array.isArray(profile.certifications)
      ? profile.certifications.slice(0, 20)
      : [],
    activities: activityDigest,
  };
}

function compactExistingProfile(profile) {
  return {
    name: profile.name || profile.full_name || null,
    headline: profile.headline || profile.title || null,
    current_company: profile.current_company || profile.company || null,
    current_role: profile.current_role || profile.role || profile.title || null,
    location: profile.location || null,
    linkedin_url: profile.linkedin_url || null,
    website: profile.website || null,
    email: profile.email || null,
    phone: profile.phone || null,
    about: trimText(profile.about || profile.summary || null, 2500),
    skills: Array.isArray(profile.skills) ? profile.skills.slice(0, 30) : [],
    languages: Array.isArray(profile.languages)
      ? profile.languages.slice(0, 20)
      : [],
    education: Array.isArray(profile.education)
      ? profile.education.slice(0, 15)
      : [],
    experience: Array.isArray(profile.experience)
      ? profile.experience.slice(0, 20)
      : [],
    social_links: Array.isArray(profile.social_links)
      ? profile.social_links.slice(0, 20)
      : [],
    certifications: Array.isArray(profile.certifications)
      ? profile.certifications.slice(0, 20)
      : [],
    awards: Array.isArray(profile.awards) ? profile.awards.slice(0, 30) : [],
    publications: Array.isArray(profile.publications)
      ? profile.publications.slice(0, 30)
      : [],
    volunteer: Array.isArray(profile.volunteer)
      ? profile.volunteer.slice(0, 20)
      : [],
    connections: profile.connections || null,
    followers: profile.followers || null,
    is_open_to_work: profile.is_open_to_work === true,
    is_hiring: profile.is_hiring === true,
    company_size: profile.company_size || null,
    company_industry: profile.company_industry || null,
    company_founded: profile.company_founded || null,
    company_website: profile.company_website || null,
    company_linkedin_url: profile.company_linkedin_url || null,
    investment_activity: Array.isArray(profile.investment_activity)
      ? profile.investment_activity.slice(0, 20)
      : [],
  };
}

function profileSignals(profile) {
  const experience = profile.experience || [];
  const current = experience[0] || {};
  return {
    name: profile.name || null,
    role: profile.current_role || current.title || profile.headline || null,
    company: profile.current_company || current.company || null,
    location: profile.location || null,
    linkedin_url: profile.linkedin_url || null,
    website: profile.website || null,
  };
}

function missingCoreFields(profile) {
  const signals = profileSignals(profile);
  return Object.entries(signals)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

// ---------------------------------------------------------------------------
// PAID API CALLS
// ---------------------------------------------------------------------------
function openRouterHeaders() {
  return {
    Authorization: `Bearer ${OPENROUTER_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://scrapingdog.com',
    'X-Title': 'LinkedIn Profile Enricher',
  };
}

function printUsage(label, responseData) {
  const usage = responseData?.usage || {};
  const cost = usage.cost ?? usage.total_cost;
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const costLabel =
    typeof cost === 'number' ? `$${cost.toFixed(6)}` : 'not returned';

  METRICS.openrouter_calls += 1;
  if (typeof cost === 'number') METRICS.openrouter_cost += cost;

  console.log(
    `  ${label}: ${promptTokens} input + ${completionTokens} output tokens, cost ${costLabel}`
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    })
  );

  return results;
}

function cleanExperienceEntry(item) {
  const companyUrl = normalizeLinkedInCompanyUrl(
    item?.company_url || item?.company_linkedin_url || null
  );

  return {
    company: cleanCompanyName(item?.company, item?.title),
    title: tidyText(item?.title),
    location: tidyText(item?.location),
    start_date: tidyText(item?.start_date),
    end_date: tidyText(item?.end_date),
    description: tidyText(item?.description),
    company_url: companyUrl,
    company_linkedin_id:
      firstPresent(
        item?.company_linkedin_id,
        item?.company_id,
        item?.company_public_id
      ) || extractLinkedInCompanyId(companyUrl),
  };
}

function normalizeAndValidateProfileResult(result, allowEmptyExperience = false) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('profile result is not an object');
  }

  if (!['high', 'medium', 'low'].includes(result.confidence_score)) {
    throw new Error('profile result is missing valid confidence_score');
  }

  if (!Array.isArray(result.experience)) {
    throw new Error('profile result is missing experience array');
  }

  result.experience = result.experience
    .map(cleanExperienceEntry)
    .filter((item) => item.company && item.title);

  // Normally an empty experience array means the model returned a degenerate
  // response, so we throw to trigger a retry on the next model. But for genuinely
  // sparse profiles (private/no public experience) empty is the correct answer.
  if (!result.experience.length && !allowEmptyExperience) {
    throw new Error('profile result has no valid experience entries');
  }

  if (!result.current_role && result.experience[0]?.title) {
    result.current_role = result.experience[0].title;
  }
  if (!result.current_company && result.experience[0]?.company) {
    result.current_company = result.experience[0].company;
  }

  if (!Array.isArray(result.missing_fields)) {
    throw new Error('profile result is missing missing_fields array');
  }

  return result;
}

async function callStructuredAI(userPrompt, allowEmptyExperience = false) {
  let lastError;

  for (const model of SYNTHESIS_MODELS) {
    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model,
          messages: [
            {
              role: 'system',
              content: `${SYSTEM_PROMPT}\n\n${EXPERIENCE_SYSTEM_PROMPT}`,
            },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1,
          // A full enriched profile (rich about + many experience rows with
          // descriptions) often needs >3500 output tokens. If the model hits the
          // cap mid-JSON the response is truncated -> JSON.parse fails -> it
          // cascades to a leaner model that returns about: null. 8000 lets the
          // strong model finish in one call -> reliable, rich output.
          max_tokens: Number(process.env.SYNTHESIS_MAX_TOKENS || 8000),
          // Route to the fastest provider for this model. hermes-4-70b latency
          // swings a lot across OpenRouter providers (13s vs 29s); sorting by
          // throughput keeps synthesis fast and consistent without changing model.
          provider: { sort: 'throughput' },
          ...openRouterModelOptions(model),
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'enriched_profile',
              strict: true,
              schema: PROFILE_SCHEMA,
            },
          },
        },
        {
          headers: openRouterHeaders(),
          timeout: 90000,
        }
      );

      printUsage(`Synthesis via ${model}`, response.data);
      const content = response.data?.choices?.[0]?.message?.content || '{}';
      return normalizeAndValidateProfileResult(
        JSON.parse(content),
        allowEmptyExperience
      );
    } catch (error) {
      lastError = error;
      console.warn(`  Synthesis model ${model} failed: ${error.message}`);
    }
  }

  throw lastError || new Error('All synthesis models failed');
}

async function callJsonAI({
  label,
  systemPrompt,
  userPrompt,
  schema,
  maxTokens,
  models = SYNTHESIS_MODELS,
}) {
  let lastError;

  for (const model of models) {
    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.05,
          max_tokens: maxTokens,
          ...openRouterModelOptions(model),
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: label,
              strict: true,
              schema,
            },
          },
        },
        {
          headers: openRouterHeaders(),
          timeout: 90000,
        }
      );

      printUsage(`${label} via ${model}`, response.data);
      const content = response.data?.choices?.[0]?.message?.content || '{}';
      return JSON.parse(content);
    } catch (error) {
      lastError = error;
      console.warn(`  ${label} model ${model} failed: ${error.message}`);
    }
  }

  throw lastError || new Error(`${label} failed`);
}

async function scrapingdogAI(query) {
  let lastError;
  const compactQuery = trimText(query, AI_MODE_MAX_QUERY_CHARS);

  if (compactQuery.length < query.length) {
    console.warn(
      `  AI Mode query trimmed from ${query.length} to ${compactQuery.length} chars to avoid 414.`
    );
  }

  for (let attempt = 0; attempt <= AI_MODE_RETRIES; attempt += 1) {
    try {
      METRICS.scrapingdog_ai_calls += 1;
      const response = await axios.get(
        'https://api.scrapingdog.com/google/ai_mode',
        {
          params: {
            api_key: SCRAPINGDOG_KEY,
            query: compactQuery,
          },
          timeout: AI_MODE_TIMEOUT_MS,
        }
      );

      const data = response.data || {};

      const references = (data.references || [])
        .filter((item) => item.link)
        .slice(0, 12)
        .map((item) => ({
          title: item.title || null,
          url: item.link,
          snippet: trimText(item.snippet || '', 500),
        }));

      const result = JSON.stringify({
        provider: 'scrapingdog_ai_mode',
        answer: trimText(data.markdown || '', MAX_RESEARCH_CHARS),
        references,
      });

      if (parseResearchResult(result).answer || references.length) {
        return result;
      }

      lastError = new Error('empty AI Mode response');
    } catch (error) {
      lastError = error;
      METRICS.scrapingdog_ai_failures += 1;
    }

    if (attempt < AI_MODE_RETRIES) {
      await sleep(AI_MODE_RETRY_DELAY_MS * (attempt + 1));
    }
  }

  console.warn(`  ScrapingDog AI research failed: ${lastError.message}`);
  return '';
}

function parseResearchResult(result) {
  if (!result) return { answer: '', references: [] };
  try {
    return JSON.parse(result);
  } catch {
    return { answer: String(result), references: [] };
  }
}

function isUsefulResearchResult(result) {
  const parsed = parseResearchResult(result);
  const answer = parsed.answer || '';
  const references = parsed.references || [];
  return answer.length >= 500 || references.length >= 2;
}

function normalizedText(value) {
  return String(value || '').toLowerCase();
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return String(value || '');
  }
}

function normalizedEvidenceText(value) {
  return normalizedText(safeDecodeURIComponent(value))
    .replace(/https?:\/\/(?:www\.)?/g, '')
    .replace(/\/+$/g, '');
}

function resultText(result) {
  const parsed = parseResearchResult(result);
  const referenceText = (parsed.references || [])
    .map((item) => `${item.title || ''} ${item.url || ''} ${item.snippet || ''}`)
    .join(' ');
  return normalizedText(`${parsed.answer || ''} ${referenceText}`);
}

function namePartsForMatch(name) {
  return normalizedText(name)
    .split(/\s+/)
    .map((part) => part.replace(/[^a-z]/g, ''))
    .filter((part) => part.length > 1)
    .slice(0, 3);
}

function profileIdForMatch(profile) {
  return normalizedEvidenceText(
    profile?.linkedin_public_identifier ||
      getLinkedInProfileId(profile?.linkedin_url || '')
  )
    .replace(/^\/+|\/+$/g, '')
    .split(/[/?#]/)[0];
}

function linkedInUrlForMatch(profile) {
  return normalizedEvidenceText(profile?.linkedin_url || '').replace(/\/+$/g, '');
}

function linkedinIdentityPatterns(profile) {
  const profileId = profileIdForMatch(profile);
  const linkedinUrl = linkedInUrlForMatch(profile);

  if (!profileId && !linkedinUrl) return [];

  return [
    linkedinUrl,
    profileId ? `linkedin.com/in/${profileId}` : null,
    profileId ? `in.linkedin.com/in/${profileId}` : null,
    profileId ? `linkedin.com/posts/${profileId}_` : null,
    profileId ? `www.linkedin.com/posts/${profileId}_` : null,
  ].filter(Boolean);
}

function textContainsAcceptedLinkedInIdentity(text, profile) {
  const normalized = normalizedEvidenceText(text);
  const patterns = linkedinIdentityPatterns(profile);

  if (!normalized || !patterns.length) return false;

  return patterns.some((pattern) => pattern && normalized.includes(pattern));
}

function isSparseLinkedInFallbackProfile(profile) {
  return (
    profile?.profile_source === 'linkedin_api_fallback' &&
    !profile.current_company &&
    !profile.current_role &&
    !profile.location &&
    validExperienceCount(profile) === 0
  );
}

function hasExactLinkedInAnchor(result, profile) {
  return textContainsAcceptedLinkedInIdentity(resultText(result), profile);
}

function referencesContainExactLinkedInAnchor(result, profile) {
  const parsed = parseResearchResult(result);
  return (parsed.references || []).some((item) => {
    return textContainsAcceptedLinkedInIdentity(item.url || '', profile);
  });
}

function researchMatchesProfile(result, profile, provider) {
  if (!result) return false;

  if (!isSparseLinkedInFallbackProfile(profile)) {
    return isUsefulResearchResult(result);
  }

  if (
    referencesContainExactLinkedInAnchor(result, profile)
  ) {
    return true;
  }

  if (provider === 'scrapingdog_ai_mode' || provider === PRIVATE_PROFILE_MODEL) {
    console.warn(
      '  Rejecting private-profile research because it did not match the LinkedIn URL/slug.'
    );
  }

  return false;
}

function hasAcceptedPrivateProfileResearch(research, profile) {
  if (!isSparseLinkedInFallbackProfile(profile)) return true;
  return researchHasReferenceLinkedInAnchor(research, profile);
}

function researchHasLinkedInAnchor(research, profile) {
  return textContainsAcceptedLinkedInIdentity(research, profile);
}

function researchHasReferenceLinkedInAnchor(research, profile) {
  const text = String(research || '');

  if (!text || !linkedinIdentityPatterns(profile).length) return false;

  const referenceBlocks = text.match(/"references"\s*:\s*\[[\s\S]*?\]/g) || [];
  return referenceBlocks.some((block) => {
    const urls = Array.from(
      block.matchAll(/"(?:url|link)"\s*:\s*"([^"]+)"/g),
      (match) => match[1]
    );
    return urls.some((url) => textContainsAcceptedLinkedInIdentity(url, profile));
  });
}

function normalizeForEvidence(value) {
  return normalizedText(value)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function evidenceIncludes(text, value) {
  const needle = normalizeForEvidence(value);
  if (!needle) return false;
  return normalizeForEvidence(text).includes(needle);
}

function hasDateRangeEvidence(text) {
  return /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+20\d{2}\b.{0,80}\b(present|20\d{2})\b/i.test(text) ||
    /\b20\d{2}\b.{0,80}\b(present|20\d{2})\b/i.test(text);
}

function hasExperienceSectionEvidence(text) {
  return /\bexperience\b|\bfull-time\b|\bself-employed\b|\bpart-time\b|\bcontract\b|\bintern(ship)?\b|\bpartner\b|\bmanager\b|\bassistant\b|\badvisor\b|\bengineer\b|\bfounder\b|\bceo\b|\bcfo\b|\bdirector\b/i.test(text);
}

function isExperienceEntrySupportedByResearch(entry, research) {
  if (!entry?.company || !entry?.title || !research) return false;

  const companySupported = evidenceIncludes(research, entry.company);
  const titleSupported = evidenceIncludes(research, entry.title);

  if (!companySupported || !titleSupported) return false;

  if (isFounderOrCurrentRole(entry.title) && hasLinkedInProfileExperienceHint(research)) {
    return true;
  }

  if (entry.start_date && evidenceIncludes(research, entry.start_date)) {
    return true;
  }

  if (entry.end_date && evidenceIncludes(research, entry.end_date)) {
    return true;
  }

  return hasExperienceSectionEvidence(research) && hasDateRangeEvidence(research);
}

function isFounderOrCurrentRole(title) {
  return /\b(founder|co-founder|ceo|chief|owner|partner|research analyst|creator|strategist|educator)\b/i.test(
    title || ''
  );
}

function hasLinkedInProfileExperienceHint(research) {
  return /linkedin\.com\/in\/|experience\s*\*|experience section|current role|headline|building\s+/i.test(
    research || ''
  );
}

function sanitizePrivateFallbackExperience(result, profile, research) {
  if (!isSparseLinkedInFallbackProfile(profile)) {
    return result;
  }

  const verifiedExperience = (result.experience || [])
    .map(cleanExperienceEntry)
    .filter((entry) => isExperienceEntrySupportedByResearch(entry, research));

  if (verifiedExperience.length === (result.experience || []).length) {
    return result;
  }

  if (!verifiedExperience.length) {
    console.warn(
      '  Private-profile identity found, but no explicit experience evidence was found. Stripping inferred experience.'
    );
  } else {
    console.warn(
      `  Removed ${(result.experience || []).length - verifiedExperience.length} unsupported private-profile experience entries.`
    );
  }

  const current = verifiedExperience[0] || {};
  return {
    ...result,
    current_company: current.company || null,
    current_role: current.title || null,
    location: current.location || result.location || profile.location || null,
    experience: verifiedExperience,
    confidence_score: verifiedExperience.length ? result.confidence_score : 'low',
    missing_fields: Array.from(
      new Set([
        ...(result.missing_fields || []),
        ...(verifiedExperience.length ? [] : ['experience', 'current_company', 'current_role']),
        'unsupported_private_experience_removed',
      ])
    ),
  };
}

function sameExperienceIdentity(left, right) {
  return (
    normalizedText(left?.company) === normalizedText(right?.company) &&
    normalizedText(left?.title) === normalizedText(right?.title)
  );
}

function sanitizeLowEvidenceBaselineResult(result, profile, research) {
  const baselineExperience = profile.experience || [];
  const baselineCount = validExperienceCount(profile);
  const resultCount = validExperienceCount(result);

  if (
    profile?.profile_source !== 'linkedin_api' ||
    baselineCount < 1 ||
    baselineCount > LOW_EVIDENCE_BASELINE_ONLY_MAX ||
    resultCount <= baselineCount ||
    researchHasLinkedInAnchor(research, profile)
  ) {
    return result;
  }

  const keptExperience = baselineExperience
    .map((baselineItem) => {
      const matchingResult = (result.experience || []).find((item) =>
        sameExperienceIdentity(item, baselineItem)
      );
      return cleanExperienceEntry(matchingResult || baselineItem);
    })
    .filter((item) => item.company && item.title);

  console.warn(
    `  Baseline has ${baselineCount} role(s) and no exact LinkedIn evidence for expansion. Keeping baseline experience only.`
  );

  const current = keptExperience[0] || {};
  return {
    ...result,
    current_company: current.company || result.current_company || null,
    current_role: current.title || result.current_role || null,
    location: current.location || result.location || profile.location || null,
    experience: keptExperience,
    confidence_score: result.confidence_score === 'high' ? 'medium' : result.confidence_score,
    missing_fields: Array.from(
      new Set([...(result.missing_fields || []), 'unsupported_extra_experience_removed'])
    ),
  };
}

function sanitizePrivateFallbackResult(result, profile, research) {
  if (hasAcceptedPrivateProfileResearch(research, profile)) {
    return result;
  }

  console.warn(
    '  Private profile has no anchored evidence. Stripping inferred experience.'
  );

  const rawNameParts = String(profile.name || result.name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const profileId =
    profile.linkedin_public_identifier || getLinkedInProfileId(profile.linkedin_url || '');

  return {
    ...result,
    name: profile.name || result.name || null,
    first_name: rawNameParts[0] || result.first_name || null,
    last_name: rawNameParts.slice(1).join(' ') || result.last_name || null,
    headline: null,
    current_company: null,
    current_role: null,
    location: null,
    linkedin_url: profile.linkedin_url || result.linkedin_url || null,
    social_links: profile.linkedin_url
      ? [{ platform: 'LinkedIn', url: profile.linkedin_url, handle: profileId || null }]
      : [],
    website: null,
    email: null,
    phone: null,
    about: null,
    experience: [],
    education: [],
    skills: [],
    languages: [],
    certifications: [],
    awards: [],
    publications: [],
    volunteer: [],
    connections: null,
    followers: null,
    is_open_to_work: false,
    is_hiring: false,
    company_size: null,
    company_industry: null,
    company_founded: null,
    company_website: null,
    company_linkedin_url: null,
    investment_activity: [],
    confidence_score: 'low',
    data_source: 'enriched',
    missing_fields: [
      'current_company',
      'current_role',
      'location',
      'experience',
      'education',
      'skills',
      'about',
      'private_or_not_indexed_linkedin_profile',
    ],
  };
}

function buildProfileNotFoundResult(profile) {
  const rawNameParts = String(profile.name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const profileId =
    profile.linkedin_public_identifier || getLinkedInProfileId(profile.linkedin_url || '');

  return {
    status: 404,
    error: 'profile_not_found',
    reason: 'private_or_unindexed_profile',
    message:
      'LinkedIn profile API failed and no accepted research source matched the exact LinkedIn URL or slug.',
    name: profile.name || null,
    first_name: rawNameParts[0] || null,
    last_name: rawNameParts.slice(1).join(' ') || null,
    headline: null,
    current_company: null,
    current_role: null,
    location: null,
    linkedin_url: profile.linkedin_url || null,
    linkedin_public_identifier: profileId || null,
    social_links: profile.linkedin_url
      ? [{ platform: 'LinkedIn', url: profile.linkedin_url, handle: profileId || null }]
      : [],
    website: null,
    email: null,
    phone: null,
    about: null,
    skills: [],
    languages: [],
    education: [],
    experience: [],
    certifications: [],
    awards: [],
    publications: [],
    volunteer: [],
    connections: null,
    followers: null,
    is_open_to_work: false,
    is_hiring: false,
    company_size: null,
    company_industry: null,
    company_founded: null,
    company_website: null,
    company_linkedin_url: null,
    investment_activity: [],
    confidence_score: 'low',
    data_source: 'enriched',
    missing_fields: [
      'current_company',
      'current_role',
      'location',
      'experience',
      'education',
      'skills',
      'about',
      'private_or_not_indexed_linkedin_profile',
    ],
  };
}

function fallbackProviders() {
  return SEARCH_FALLBACK.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function openRouterResearch(query, model, label, maxTokens = 2500) {
  try {
    if (label.startsWith('Perplexity') || model.startsWith('perplexity/')) {
      METRICS.perplexity_search_calls += 1;
    } else {
      METRICS.openrouter_search_calls += 1;
    }

    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model,
        messages: [
          {
            role: 'system',
            content:
              'You are a careful web researcher. Return only source-backed facts. ' +
              'For career history, avoid same-name matches. Include raw source URLs ' +
              'beside every role, not citation numbers only. If LinkedIn public mode ' +
              'hides older roles, search bios, snippets, articles, company pages, ' +
              'speaker pages, podcasts, resumes, and social profiles.',
          },
          { role: 'user', content: query },
        ],
        temperature: 0.05,
        max_tokens: maxTokens,
      },
      {
        headers: openRouterHeaders(),
        timeout: SEARCH_FALLBACK_TIMEOUT_MS,
      }
    );

    printUsage(`${label} research via ${model}`, response.data);
    const message = response.data?.choices?.[0]?.message || {};
    const answer = message.content || '';
    const rawCitations =
      response.data?.citations ||
      response.data?.references ||
      message.citations ||
      message.annotations ||
      [];
    const references = Array.isArray(rawCitations)
      ? rawCitations
          .map((item) => {
            if (typeof item === 'string') {
              return { title: null, url: item, snippet: '' };
            }
            return {
              title: item.title || item.name || null,
              url: item.url || item.link || item.href || null,
              snippet: trimText(item.snippet || item.text || item.content || '', 500),
            };
          })
          .filter((item) => item.url)
      : [];

    return JSON.stringify({
      provider: model,
      answer: trimText(answer, MAX_RESEARCH_CHARS),
      references,
    });
  } catch (error) {
    console.warn(`  ${label} research failed: ${error.message}`);
    return '';
  }
}

async function perplexitySearch(query) {
  return openRouterResearch(query, PERPLEXITY_SEARCH_MODEL, 'Perplexity');
}

// Fetch a person's own website and return its visible text. The personal site is
// the most authoritative public source for the employer list (it can't be
// same-name confused), so this deterministic fetch reliably anchors companies
// that the non-deterministic AI Mode / Perplexity passes sometimes miss.
async function fetchWebsiteText(url) {
  if (!url) return '';
  const fullUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const response = await axios.get(fullUrl, {
      timeout: Number(process.env.WEBSITE_FETCH_TIMEOUT_MS || 8000),
      maxRedirects: 5,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      },
      responseType: 'text',
    });
    const html = String(response.data || '');
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      // Keep image alt text — company logos are often <img alt="eBay">.
      .replace(/<img[^>]*\balt="([^"]*)"[^>]*>/gi, ' $1 ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text;
  } catch (error) {
    console.warn(`  Website fetch failed (${fullUrl}): ${error.message}`);
    return '';
  }
}

async function perplexityBatchSearch(items, batchLabel) {
  const prompt = `
Run one research pass that answers multiple career-history search angles.

Important:
- Keep each requested section separated with its label.
- This is about one exact person only. Do not mix same-name results.
- For every verified experience role, include company, title, location, start
  date, end date, description, company LinkedIn URL, company LinkedIn ID/slug,
  and raw source URLs.
- If you find older LinkedIn roles hidden from public mode, include them.
- If a section has no evidence, say "not found" for that section.

Research sections:
${items
  .map(
    (item, index) => `
[${index + 1}] ${item.label}
${item.query}`
  )
  .join('\n\n---\n\n')}
`.trim();

  return openRouterResearch(
    prompt,
    PERPLEXITY_SEARCH_MODEL,
    `Perplexity batch ${batchLabel}`,
    6500
  );
}

async function openRouterSearch(query) {
  return openRouterResearch(query, OPENROUTER_SEARCH_MODEL, 'OpenRouter search');
}

async function openRouterBatchSearch(items, batchLabel) {
  const prompt = `
Run one fallback web research pass for these sections. Keep each requested
section separated with its label and include source URLs beside every fact.

${items
  .map(
    (item, index) => `
[${index + 1}] ${item.label}
${item.query}`
  )
  .join('\n\n---\n\n')}
`.trim();

  return openRouterResearch(
    prompt,
    OPENROUTER_SEARCH_MODEL,
    `OpenRouter search batch ${batchLabel}`,
    4500
  );
}

async function openAiPrivateProfileFallback(profile, items) {
  if (!PRIVATE_PROFILE_OPENAI_FALLBACK || !isSparseLinkedInFallbackProfile(profile)) {
    return '';
  }

  const signals = profileSignals(profile);
  const profileId =
    profile.linkedin_public_identifier || getLinkedInProfileId(profile.linkedin_url || '');
  const requestedSections = items
    .map((item, index) => `[${index + 1}] ${item.label}\n${item.query}`)
    .join('\n\n---\n\n');

  const prompt = `
The LinkedIn Profile API failed and Google AI Mode did not provide a reliable
match. This may be a private or non-indexed LinkedIn profile.

Target identity:
- LinkedIn URL: ${signals.linkedin_url || 'unknown'}
- LinkedIn slug/public identifier: ${profileId || 'unknown'}
- Inferred name from slug: ${signals.name || 'unknown'}

Task:
- Use only knowledge that clearly belongs to this exact LinkedIn identity.
- If you cannot find source evidence tied to this exact LinkedIn URL or slug,
  return only "not found".
- Do not return same-name people.
- Do not invent company, role, dates, education, or experience.
- Do not use model memory. Use source-backed facts only.
- For every experience role, include company LinkedIn URL, company LinkedIn
  ID/slug, and the source URL beside that role when visible.
- The source URL/snippet must include the target LinkedIn slug or exact LinkedIn
  URL. If sources only mention the same name, treat it as not found.

Requested research sections:
${trimText(requestedSections, 20000)}
`.trim();

  const result = await openRouterResearch(
    prompt,
    PRIVATE_PROFILE_MODEL,
    'OpenAI private-profile fallback',
    2500
  );

  if (!referencesContainExactLinkedInAnchor(result, profile)) {
    console.warn(
      '  OpenAI private-profile fallback had no exact LinkedIn source anchor.'
    );
    return '';
  }

  return result;
}

function compactExperienceForPrompt(experience, limit = 8) {
  return (experience || [])
    .filter((item) => item && (item.company || item.title || item.description))
    .slice(0, limit)
    .map((item) => ({
      company: item.company || null,
      title: item.title || null,
      location: item.location || null,
      start_date: item.start_date || null,
      end_date: item.end_date || null,
      description: trimText(item.description || '', RESCUE_FIELD_CHARS) || null,
      company_url: item.company_url || null,
      company_linkedin_id: item.company_linkedin_id || null,
    }));
}

function compactResearchForRescue(research) {
  const text = String(research || '');
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) =>
      /experience|linkedin\.com\/in|linkedin\.com\/posts|title|company|role|worked|present|20\d{2}|intern|manager|founder|partner|director|engineer|advisor|assistant/i.test(line)
    )
    .slice(0, 80)
    .join('\n');

  return trimText(lines || text, RESCUE_CONTEXT_CHARS);
}

function buildExperienceRescueQuery(profile, result, research) {
  const signals = profileSignals(profile);
  const visibleExperience = JSON.stringify(
    compactExperienceForPrompt(profile.experience),
    null,
    2
  );
  const currentExperience = JSON.stringify(
    compactExperienceForPrompt(result.experience, 5),
    null,
    2
  );

  return `
The previous enrichment produced too few experience entries for this LinkedIn
profile. Do one focused rescue research pass to recover missing older roles.

Identity:
- Name: ${signals.name || result.name || 'unknown'}
- LinkedIn: ${signals.linkedin_url || result.linkedin_url || 'unknown'}
- Current role/company: ${result.current_role || signals.role || 'unknown'} at ${result.current_company || signals.company || 'unknown'}
- Location: ${signals.location || result.location || 'unknown'}

Visible baseline experience from LinkedIn/API:
${visibleExperience}

Current incomplete final experience:
${currentExperience}

Research goal:
- Find the complete newest-to-oldest career timeline.
- Prioritize older hidden LinkedIn roles, grouped company roles, internships,
  cashier/early jobs, sports/business-development roles, finance internships,
  and any roles missing from the current final experience.
- Search public indexed LinkedIn snippets, biographies, speaker pages,
  company pages, podcast pages, resumes/CVs, articles, and social profiles.
- Return only verified roles for this exact person.
- For every role include: company, title, location, start date, end date,
  description, company LinkedIn URL, company LinkedIn ID/slug, and raw source
  URLs.
- Do not include name-only matches.

Useful first-pass research context:
${compactResearchForRescue(research)}
`.trim();
}

function buildShortExperienceRescueQueries(profile, result) {
  const signals = profileSignals(profile);
  const linkedinUrl = signals.linkedin_url || result.linkedin_url || '';
  const profileId =
    profile.linkedin_public_identifier || getLinkedInProfileId(linkedinUrl);
  const name =
    signals.name || result.name || nameFromLinkedInProfileId(profileId) || profileId;
  const currentCompany = result.current_company || signals.company || '';
  const currentRole = result.current_role || signals.role || '';

  return [
    {
      label: 'experience_rescue_exact',
      query: `"${name}" "${profileId}" "Experience"`,
    },
    {
      label: 'experience_rescue_dates',
      query: `"${name}" "${profileId}" "present" "20" "company"`,
    },
    {
      label: 'experience_rescue_founder',
      query: `"${name}" "${profileId}" "Founder" OR "Co-Founder" OR "Intern"`,
    },
    currentCompany
      ? {
          label: 'experience_rescue_current_company',
          query: `"${name}" "${currentCompany}" "${profileId}" LinkedIn`,
        }
      : null,
    currentRole
      ? {
          label: 'experience_rescue_current_role',
          query: `"${name}" "${currentRole}" "${profileId}" LinkedIn experience`,
        }
      : null,
    linkedinUrl
      ? {
          label: 'experience_rescue_posts',
          query: `site:linkedin.com/posts "${profileId}" "${name}"`,
        }
      : null,
  ].filter((item) => item?.query && !item.query.includes('""'));
}

function validExperienceCount(result) {
  return (result.experience || []).filter((item) => item.company && item.title)
    .length;
}

// Decide whether to run the expensive planner + second-wave follow-up pass.
// Always off in RESEARCH_MODE=off. Otherwise: explicit env override wins;
// deep mode always runs it; standard mode auto-enables when the LinkedIn API
// returned fewer roles than the sparse threshold (LinkedIn hides old roles).
function shouldRunExperienceFollowup(profile) {
  if (process.env.EXPERIENCE_FOLLOWUP_ENABLED === 'false') return false;
  if (RESEARCH_MODE === 'off') return false;
  if (process.env.EXPERIENCE_FOLLOWUP_ENABLED === 'true') return true;
  if (RESEARCH_MODE === 'deep') return true;
  if (
    EXPERIENCE_FOLLOWUP_SPARSE_THRESHOLD > 0 &&
    profile?.profile_source === 'linkedin_api' &&
    validExperienceCount(profile) < EXPERIENCE_FOLLOWUP_SPARSE_THRESHOLD
  ) {
    console.log(
      `  LinkedIn API returned only ${validExperienceCount(profile)} role(s) — enabling follow-up pass to recover hidden older roles.`
    );
    return true;
  }
  return false;
}

function shouldRescueExperience(result, profile) {
  if (!EXPERIENCE_RESCUE_ENABLED || !EXPERIENCE_FIRST) return false;
  if (isSparseLinkedInFallbackProfile(profile) && !PRIVATE_PROFILE_RESCUE) {
    return false;
  }
  const baselineCount = validExperienceCount(profile);
  const threshold = Math.max(RESCUE_MIN_EXPERIENCE_COUNT, baselineCount);
  return validExperienceCount(result) < threshold;
}

async function rescueExperienceResearch(profile, result, research) {
  console.log(
    `  Experience looks thin (${validExperienceCount(result)} roles). Running one rescue search...`
  );

  if (isSparseLinkedInFallbackProfile(profile)) {
    const rescueQueries = buildShortExperienceRescueQueries(profile, result);
    const rescueResults = await runResearchQueries(rescueQueries, 0, profile);
    return rescueResults
      .filter(({ result: itemResult }) => itemResult)
      .map(({ label, result: itemResult }) => `[${label}]\n${itemResult}`)
      .join('\n\n');
  }

  const query = buildExperienceRescueQuery(profile, result, research);
  const aiModeRescue = await scrapingdogAI(query);
  if (isUsefulResearchResult(aiModeRescue)) {
    return aiModeRescue;
  }

  console.log(`    fallback paid rescue: ${RESCUE_SEARCH_MODEL}`);
  return openRouterResearch(
    trimText(query, AI_MODE_MAX_QUERY_CHARS),
    RESCUE_SEARCH_MODEL,
    'Paid rescue',
    5000
  );
}

function shouldUseAiMode(index) {
  return AI_MODE_MAX_CALLS < 0 || index < AI_MODE_MAX_CALLS;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function researchWithFallback({ label, query }, index, profile = null) {
  let result = '';
  let provider = 'none';

  if (shouldUseAiMode(index)) {
    result = await scrapingdogAI(query);
    provider = 'scrapingdog_ai_mode';
  }

  if (!researchMatchesProfile(result, profile, provider)) {
    if (isSparseLinkedInFallbackProfile(profile)) {
      const privateFallback = await openAiPrivateProfileFallback(profile, [
        { label, query },
      ]);
      if (researchMatchesProfile(privateFallback, profile, PRIVATE_PROFILE_MODEL)) {
        return {
          label: 'private_profile_openai_fallback',
          provider: PRIVATE_PROFILE_MODEL,
          result: privateFallback,
        };
      }

      if (!PRIVATE_PROFILE_USE_PAID_WEB_FALLBACK) {
        return { label, provider, result: '' };
      }
    }

    for (const fallbackProvider of fallbackProviders()) {
      console.log(`    fallback ${fallbackProvider}: ${label}`);

      const fallback =
        fallbackProvider === 'perplexity'
          ? await perplexitySearch(query)
          : fallbackProvider === 'openrouter_search'
            ? await openRouterSearch(query)
            : '';

      if (researchMatchesProfile(fallback, profile, fallbackProvider)) {
        result = fallback;
        provider = parseResearchResult(fallback).provider || fallbackProvider;
      }

      if (researchMatchesProfile(result, profile, provider)) {
        break;
      }
    }
  }

  return {
    label,
    provider,
    result: researchMatchesProfile(result, profile, provider) ? result : '',
  };
}

async function runResearchQueries(items, startIndex = 0, profile = null) {
  if (!PERPLEXITY_BATCH_MODE) {
    return Promise.all(
      items.map((item, index) =>
        researchWithFallback(item, startIndex + index, profile)
      )
    );
  }

  const aiModeItems = [];
  const fallbackItems = [];

  for (let index = 0; index < items.length; index += 1) {
    const absoluteIndex = startIndex + index;
    if (shouldUseAiMode(absoluteIndex)) {
      aiModeItems.push({ item: items[index], index: absoluteIndex });
    } else {
      fallbackItems.push(items[index]);
    }
  }

  const aiModeResults = await mapWithConcurrency(
    aiModeItems,
    AI_MODE_CONCURRENCY,
    async ({ item, index }) => {
      const result = await scrapingdogAI(item.query);
      if (researchMatchesProfile(result, profile, 'scrapingdog_ai_mode')) {
        return {
          label: item.label,
          provider: 'scrapingdog_ai_mode',
          result,
          needsFallback: false,
        };
      }

      return {
        label: item.label,
        provider: 'scrapingdog_ai_mode',
        result,
        needsFallback: true,
        item,
        index,
      };
    }
  );

  const weakAiModeItems = aiModeResults
    .filter((entry) => entry.needsFallback)
    .map((entry) => entry.item);
  const strongAiModeResults = aiModeResults.filter(
    (entry) => !entry.needsFallback
  );
  let allFallbackItems = [...weakAiModeItems, ...fallbackItems];
  const fallbackResults = [];
  const providers = fallbackProviders();

  if (isSparseLinkedInFallbackProfile(profile) && strongAiModeResults.length) {
    return strongAiModeResults.filter(({ result }) => result);
  }

  if (isSparseLinkedInFallbackProfile(profile) && allFallbackItems.length) {
    const privateFallback = await openAiPrivateProfileFallback(
      profile,
      allFallbackItems
    );

    if (researchMatchesProfile(privateFallback, profile, PRIVATE_PROFILE_MODEL)) {
      fallbackResults.push({
        label: 'private_profile_openai_fallback',
        provider: PRIVATE_PROFILE_MODEL,
        result: privateFallback,
      });
    }

    if (!PRIVATE_PROFILE_USE_PAID_WEB_FALLBACK) {
      return [...strongAiModeResults, ...fallbackResults].filter(
        ({ result }) => result
      );
    }
  }

  if (providers.includes('perplexity') && allFallbackItems.length) {
    const batches = chunkArray(allFallbackItems, PERPLEXITY_BATCH_SIZE);
    const perplexityResults = await Promise.all(
      batches.map(async (batch, batchIndex) => ({
        label: `perplexity_batch_${batchIndex + 1}`,
        provider: PERPLEXITY_SEARCH_MODEL,
        result: await perplexityBatchSearch(batch, batchIndex + 1),
      }))
    );
    fallbackResults.push(
      ...perplexityResults.filter((entry) =>
        researchMatchesProfile(entry.result, profile, entry.provider)
      )
    );

    const weakBatches = batches.filter(
      (_, batchIndex) =>
        !researchMatchesProfile(
          perplexityResults[batchIndex]?.result,
          profile,
          PERPLEXITY_SEARCH_MODEL
        )
    );

    if (providers.includes('openrouter_search') && weakBatches.length) {
      const openRouterResults = await Promise.all(
        weakBatches.map(async (batch, batchIndex) => ({
          label: `openrouter_search_batch_${batchIndex + 1}`,
          provider: OPENROUTER_SEARCH_MODEL,
          result: await openRouterBatchSearch(batch, batchIndex + 1),
        }))
      );
      fallbackResults.push(
        ...openRouterResults.filter((entry) =>
          researchMatchesProfile(entry.result, profile, entry.provider)
        )
      );
    }
  } else if (providers.includes('openrouter_search') && allFallbackItems.length) {
    const batches = chunkArray(allFallbackItems, PERPLEXITY_BATCH_SIZE);
    const openRouterResults = await Promise.all(
      batches.map(async (batch, batchIndex) => ({
        label: `openrouter_search_batch_${batchIndex + 1}`,
        provider: OPENROUTER_SEARCH_MODEL,
        result: await openRouterBatchSearch(batch, batchIndex + 1),
      }))
    );
    fallbackResults.push(
      ...openRouterResults.filter((entry) =>
        researchMatchesProfile(entry.result, profile, entry.provider)
      )
    );
  }

  return [...strongAiModeResults, ...fallbackResults].filter(
    ({ result }) => result
  );
}

async function callLinkedInApi(profileId, premium) {
  METRICS.linkedin_api_calls += 1;
  const response = await axios.get('https://api.scrapingdog.com/profile/', {
    params: {
      api_key: SCRAPINGDOG_KEY,
      type: 'profile',
      id: profileId,
      fresh: LINKEDIN_FRESH ? 'true' : 'false',
      ...(premium ? { premium: 'true' } : {}),
    },
    timeout: LINKEDIN_TIMEOUT_MS,
  });

  const data = response.data;
  // Scrapingdog returns 200 with {success:false, message:"...premium=true"} on
  // soft failures, so treat that as an error (not a valid profile).
  if (!data || typeof data !== 'object') {
    throw new Error('LinkedIn API returned an empty or invalid response');
  }
  const flat = Array.isArray(data) ? data[0] || {} : data;
  if (flat.success === false || (flat.message && !flat.fullName && !flat.first_name)) {
    throw new Error(`LinkedIn API soft failure: ${flat.message || 'unknown'}`);
  }
  return data;
}

// Premium scrape with its own retries. Premium is fast (~1s) and reliable, but a
// single transient blip used to fall straight through to profile_not_found. We
// retry it a few times with short backoff so a real profile is never lost to a
// one-off network/provider hiccup.
async function callLinkedInPremiumWithRetries(profileId) {
  let lastError;
  for (let attempt = 1; attempt <= LINKEDIN_PREMIUM_RETRIES; attempt += 1) {
    try {
      const raw = await callLinkedInApi(profileId, true);
      console.log(
        `  LinkedIn premium scrape succeeded${attempt > 1 ? ` (attempt ${attempt})` : ''}.`
      );
      return raw;
    } catch (error) {
      lastError = error;
      console.warn(
        `  LinkedIn premium scrape attempt ${attempt}/${LINKEDIN_PREMIUM_RETRIES} failed: ${error.message}`
      );
      if (attempt < LINKEDIN_PREMIUM_RETRIES) await sleep(700 * attempt);
    }
  }
  throw lastError || new Error('LinkedIn premium scrape failed');
}

async function fetchLinkedInProfile(linkedinUrl) {
  const profileId = getLinkedInProfileId(linkedinUrl);
  if (!profileId) throw new Error(`Invalid LinkedIn URL: ${linkedinUrl}`);

  let raw;
  if (LINKEDIN_PREMIUM === 'always') {
    raw = await callLinkedInPremiumWithRetries(profileId);
  } else {
    try {
      raw = await callLinkedInApi(profileId, false);
    } catch (error) {
      if (LINKEDIN_PREMIUM === 'never') throw error;
      // Standard scrape failed — fall back to premium proxies (with retries),
      // which is what Scrapingdog's error recommends and reliably recovers these.
      console.warn(
        `  LinkedIn standard scrape failed (${error.message}). Falling back to premium...`
      );
      raw = await callLinkedInPremiumWithRetries(profileId);
    }
  }

  const obj = Array.isArray(raw) ? (raw[0] || {}) : raw;
  const expKey = ['experience', 'positions', 'jobs', 'work', 'workHistory', 'work_history'].find(
    (k) => Array.isArray(obj[k]) && obj[k].length > 0
  );
  if (expKey) {
    const companyNames = obj[expKey]
      .map((item) => item.company_name || item.company || '')
      .filter((n) => n && !/^\*+$/.test(n));
    console.log(
      `  LinkedIn API: ${obj[expKey].length} experience item(s), companies: [${companyNames.join(', ')}]`
    );
  }

  return raw;
}

function getLinkedInProfileId(linkedinUrl) {
  return linkedinUrl.split('/in/')[1]?.split(/[/?#]/)[0] || '';
}

function nameFromLinkedInProfileId(profileId) {
  let decoded = profileId || '';
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    decoded = profileId || '';
  }

  const cleanId = decoded
    .replace(/[_+]+/g, '-')
    .split('-')
    .filter((part) => part && !/\d/.test(part))
    .slice(0, 4);

  if (!cleanId.length) return null;

  return cleanId
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function buildLinkedInFallbackProfile(linkedinUrl, reason) {
  const profileId = getLinkedInProfileId(linkedinUrl);

  return {
    profile_source: 'linkedin_api_fallback',
    fallback_reason: trimText(reason, 500),
    name: nameFromLinkedInProfileId(profileId),
    headline: null,
    current_company: null,
    current_role: null,
    location: null,
    linkedin_url: linkedinUrl,
    linkedin_public_identifier: profileId || null,
    website: null,
    about: null,
    followers: null,
    connections: null,
    is_open_to_work: false,
    is_hiring: false,
    email: null,
    phone: null,
    social_links: [],
    experience: [],
    education: [],
    skills: [],
    languages: [],
    certifications: [],
    activities: [],
  };
}

async function fetchLinkedInProfileOrFallback(linkedinUrl) {
  // The Profile API is the ground-truth source for experience, so a transient
  // failure is worth one quick retry before we drop to the weaker AI-Mode
  // fallback (keeps random profiles from losing their experience section).
  let lastError;
  for (let attempt = 0; attempt <= LINKEDIN_PROFILE_RETRIES; attempt += 1) {
    try {
      return compactProfile(await fetchLinkedInProfile(linkedinUrl), linkedinUrl);
    } catch (error) {
      lastError = error;
      if (attempt < LINKEDIN_PROFILE_RETRIES) {
        console.warn(
          `  LinkedIn profile API failed (attempt ${attempt + 1}), retrying: ${error.message}`
        );
        await sleep(600);
      }
    }
  }

  METRICS.linkedin_api_failures += 1;

  if (!LINKEDIN_PROFILE_FALLBACK) {
    throw lastError;
  }

  console.warn(
    `  LinkedIn profile API failed. Continuing with AI Mode fallback: ${lastError.message}`
  );
  return buildLinkedInFallbackProfile(linkedinUrl, lastError.message);
}

// ---------------------------------------------------------------------------
// PROVIDER-ROUTED EXPERIENCE RESEARCH
// ---------------------------------------------------------------------------
function knownCompaniesFromProfile(profile, limit = 8) {
  return (profile.experience || [])
    .map((item) => item.company)
    .filter(Boolean)
    .slice(0, limit);
}

function normalizedCompanyKey(value) {
  return normalizedText(value)
    .replace(/&/g, 'and')
    .replace(
      /\b(pvt|private|limited|ltd|inc|llc|llp|corp|corporation|co|group|grupa|groupe|holding|holdings|gmbh|ag|sas|bv|oy|ab|as)\b/g,
      ''
    )
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeLinkedInCompanyId(value) {
  if (!value) return null;
  const fromUrl = extractLinkedInCompanyId(value);
  if (fromUrl) return fromUrl;

  const raw = String(value)
    .trim()
    .replace(/^@/, '')
    .replace(/^\/+|\/+$/g, '');

  if (!raw || /https?:|linkedin\.com|[\s?#]/i.test(raw)) return null;
  return raw;
}

function isGenericCompanyName(value) {
  const key = normalizedCompanyKey(value);
  if (!key) return true;

  return [
    'self employed',
    'self employment',
    'freelance',
    'freelancer',
    'independent',
    'independent consultant',
    'consultant',
    'personal brand',
    'content creator',
    'youtube',
    'linkedin',
  ].includes(key);
}

function companyLookupTargets(result) {
  const seen = new Set();
  return (result.experience || [])
    .map((item) => cleanExperienceEntry(item))
    .filter((item) => item.company && !item.company_linkedin_id)
    .filter((item) => !isGenericCompanyName(item.company))
    .filter((item) => {
      const key = normalizedCompanyKey(item.company);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, COMPANY_ID_LOOKUP_LIMIT);
}

function buildCompanyIdLookupQuery(targets, result, profile) {
  const signals = profileSignals(profile);
  const companies = targets.map((item) => item.company).join(', ');
  const person = result.name || signals.name || '';

  return trimText(
    `Official LinkedIn company or school pages for: ${companies}. ` +
      (person ? `Person context: ${person}. ` : '') +
      'Return company names with linkedin.com/company or linkedin.com/school URLs only.',
    AI_MODE_MAX_QUERY_CHARS
  );
}

function cleanCompanyLookupRecord(item) {
  const linkedInUrl = normalizeLinkedInCompanyUrl(
    firstPresent(item?.linkedin_url, item?.company_url, item?.source_url)
  );
  const linkedInId =
    normalizeLinkedInCompanyId(item?.linkedin_id) ||
    extractLinkedInCompanyId(linkedInUrl);

  if (!linkedInUrl || !/linkedin\.com\/(?:company|school)\//i.test(linkedInUrl)) {
    return null;
  }
  if (!linkedInId) return null;
  if (!['high', 'medium'].includes(item?.confidence)) return null;

  return {
    company: item.company || null,
    linkedin_url: linkedInUrl,
    linkedin_id: linkedInId,
    confidence: item.confidence,
    source_url: item.source_url || linkedInUrl,
  };
}

async function enrichExperienceCompanyLinkedInIds(result, profile) {
  if (!COMPANY_ID_LOOKUP_ENABLED) return result;

  const targets = companyLookupTargets(result);
  if (!targets.length) return result;

  console.log(
    `  Resolving ${targets.length} missing company LinkedIn IDs...`
  );

  const query = buildCompanyIdLookupQuery(targets, result, profile);
  const aiModeResult = await scrapingdogAI(query);
  if (!isUsefulResearchResult(aiModeResult)) {
    console.warn('  Company LinkedIn ID lookup returned no usable evidence.');
    return result;
  }

  let lookup;
  try {
    lookup = await callJsonAI({
      label: 'company_linkedin_id_lookup',
      systemPrompt: `
You map company names to official LinkedIn company/school URLs from supplied
search evidence. Use only the supplied evidence. Do not infer IDs from memory.
Return not_found when the evidence does not contain an official LinkedIn
company/school URL.
`.trim(),
      userPrompt: `
Target companies:
${JSON.stringify(targets.map((item) => item.company), null, 2)}

Search evidence:
${trimText(aiModeResult, 20000)}
`.trim(),
      schema: COMPANY_ID_LOOKUP_SCHEMA,
      maxTokens: 1800,
      models: PLANNER_MODELS,
    });
  } catch (error) {
    console.warn(`  Company LinkedIn ID parser failed: ${error.message}`);
    return result;
  }

  const byCompany = new Map();
  for (const item of lookup.companies || []) {
    const cleaned = cleanCompanyLookupRecord(item);
    if (!cleaned) continue;
    const key = normalizedCompanyKey(cleaned.company);
    if (key) byCompany.set(key, cleaned);
  }

  if (!byCompany.size) return result;

  const experience = (result.experience || []).map((item) => {
    const cleaned = cleanExperienceEntry(item);
    if (cleaned.company_linkedin_id) return cleaned;

    const match = byCompany.get(normalizedCompanyKey(cleaned.company));
    if (!match) return cleaned;

    return {
      ...cleaned,
      company_url: cleaned.company_url || match.linkedin_url,
      company_linkedin_id: match.linkedin_id,
    };
  });

  const filledCount = experience.filter((item, index) => {
    const before = result.experience?.[index] || {};
    return !before.company_linkedin_id && item.company_linkedin_id;
  }).length;

  if (filledCount) {
    console.log(`  Filled ${filledCount} company LinkedIn IDs.`);
  }

  return { ...result, experience };
}

function buildIdentityAnchor(scenario, profile) {
  const signals = profileSignals(profile);
  const knownCompanies = knownCompaniesFromProfile(profile);

  const identity = [
    `Name: ${signals.name || 'unknown'}`,
    `LinkedIn: ${signals.linkedin_url || 'unknown'}`,
    `Current role: ${signals.role || 'unknown'}`,
    `Known company: ${signals.company || knownCompanies[0] || 'unknown'}`,
    `Location: ${signals.location || 'unknown'}`,
    knownCompanies.length
      ? `Known companies: ${knownCompanies.join(', ')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  return `
Identity anchor:
${identity}

This is scenario ${scenario}. Research only this exact person. Use the LinkedIn
URL, known company, and location to disambiguate. Exclude name-only matches.
Return concise facts with source URLs. Never guess dates or contact details.
`.trim();
}

function buildExperienceFirstQueries(scenario, profile) {
  const signals = profileSignals(profile);
  const name = signals.name || 'unknown person';
  const company = signals.company || 'unknown company';
  const linkedinUrl = signals.linkedin_url || '';
  const location = signals.location || '';
  const knownCompanies = knownCompaniesFromProfile(profile, 12);
  const knownCompanyText = knownCompanies.join(', ') || company;
  const guardrail = buildIdentityAnchor(scenario, profile);

  const visibleExperience = (profile.experience || [])
    .map((item, index) => {
      const parts = [
        `${index + 1}. ${item.title || 'unknown title'}`,
        item.company ? `at ${item.company}` : '',
        item.start_date || item.end_date
          ? `(${item.start_date || '?'} - ${item.end_date || '?'})`
          : '',
      ].filter(Boolean);
      return parts.join(' ');
    })
    .join('\n') || 'No visible experience from baseline.';

  const base = [
    {
      label: 'experience_complete_breakdown',
      query: `${guardrail}

I need a complete breakdown of where this person has worked till now:
${linkedinUrl || name}

Return the answer as a career timeline. Separate:
- current entrepreneurial/content/founder roles
- past professional experience
- university organizations or leadership roles

For every role include title, company, start date, end date or Present,
duration, location, company LinkedIn URL, company LinkedIn ID/slug, and source
URL.

Use the exact LinkedIn profile slug as the identity anchor. LinkedIn posts by
the same slug can verify identity, but do not turn posts/headline/about text
into experience unless they explicitly mention title + company + dates.
If LinkedIn indexed snippets show the Experience section, prioritize those
rows over summaries.`,
    },
    {
      label: 'experience_linkedin_indexed',
      query: `${guardrail}

LinkedIn public mode may hide old roles behind sign-in. Use public indexed
snippets, search result text, cached summaries, and any public pages to
reconstruct the FULL LinkedIn experience section for:
${linkedinUrl || name}

Visible baseline experience:
${visibleExperience}

Return every role you can verify: company, title, location, start date, end
date, duration, description, and source URL. Include old roles too.`,
    },
    {
      label: 'experience_indexed_rows',
      query: `${guardrail}

Target LinkedIn profile:
${linkedinUrl || name}

Extract the indexed LinkedIn Experience section as structured rows. Search
Google-indexed LinkedIn profile snippets and cached search snippets for this
exact profile slug.

Return 3-5 experience rows if visible. For each row include:
- title
- company
- company LinkedIn URL if visible
- company LinkedIn ID/slug if visible
- location
- start date
- end date or Present
- duration
- description snippet
- raw source URL

Only use rows that appear as LinkedIn Experience entries. Do not create roles
from posts, headline, creator bio, about text, hashtags, or general summaries.
University organizations, campus cells, internships, and short production or
operations roles can be included only if they appear as explicit experience
rows with title/company/date or duration.
If only headline/about is visible, return "experience rows not found".`,
    },
    {
      label: 'experience_full_web',
      query: `${guardrail}

Find the complete work history of ${name}. Search broadly across biographies,
speaker pages, company announcements, podcasts, interviews, press releases,
portfolio pages, founder pages, team pages, resumes, CVs, and old profiles.
Return a newest-to-oldest career timeline with source URLs.`,
    },
    {
      label: 'experience_exact_name_companies',
      query: `${guardrail}

Search exact-name career evidence:
"${name}" "${knownCompanyText}" experience career previous roles employment

Find companies not visible in the public LinkedIn scrape. Return only roles
that match this exact person.`,
    },
    {
      label: 'experience_resume_cv_bio',
      query: `${guardrail}

Search for "${name}" resume OR CV OR biography OR bio OR "about" OR "profile".
Extract all work experience, titles, dates, and descriptions from public pages.
Return source URLs.`,
    },
    {
      label: 'experience_role_keywords',
      query: `${guardrail}

Search "${name}" with role keywords that often appear in hidden LinkedIn
experience: founder, co-founder, COO, chief, director, manager, business
development, partnerships, revenue, analyst, intern, cashier, consultant,
advisor. Return verified roles only.`,
    },
    {
      label: 'experience_social_bios',
      query: `${guardrail}

Search public social and professional bios for ${name}: X, GitHub, Medium,
Substack, Product Hunt, AngelList, Crunchbase, speaker pages, conference pages,
YouTube/podcast notes, and personal websites. Extract all career history clues
with source URLs.`,
    },
    {
      label: 'experience_news_announcements',
      query: `${guardrail}

Search news, press releases, launch announcements, funding announcements,
investment pages, and company blogs mentioning ${name}. Extract roles,
companies, dates, and responsibilities.`,
    },
    {
      label: 'experience_location_disambiguation',
      query: `${guardrail}

Search using location and identity anchors:
"${name}" "${location}" "${company}" work history career LinkedIn

Use this to avoid same-name confusion and recover older roles. Return verified
experience facts only.`,
    },
  ];

  // Personal website (if known) is the most reliable source for a complete bio.
  const website = profile.website || '';
  if (website) {
    const domain = website.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    base.push({
      label: 'experience_personal_website',
      query: `${guardrail}

Fetch career history from this person's personal website or blog:
${website}

Also search: site:${domain} OR "${domain}" experience about bio career

Extract every company, job title, date range, and description mentioned.
Return source URLs.`,
    });
  }

  for (const knownCompany of knownCompanies.slice(0, 8)) {
    base.push({
      label: `experience_company_${knownCompany}`,
      query: `${guardrail}

Deep search this exact person's role at "${knownCompany}".
Find exact title, start date, end date, location, responsibilities, associated
      skills, announcements, and source URLs. Also find whether this role was part of
a grouped LinkedIn experience with sub-roles/promotions.`,
    });
  }

  if (profile.profile_source === 'linkedin_api_fallback') {
    base.unshift({
      label: 'linkedin_profile_recovery',
      query: `${guardrail}

The Scrapingdog LinkedIn Profile API failed for this URL:
${linkedinUrl || 'unknown'}

Recover the public professional profile from web evidence. Prioritize the
complete LinkedIn experience section, current title/company, location,
headline, education, skills, and source URLs. Use the LinkedIn URL/profile slug
as the strongest identity anchor and avoid same-name matches.`,
    });
  }

  return base;
}

function buildSparseLinkedInFallbackQueries(profile) {
  const linkedinUrl = profile.linkedin_url || '';
  const profileId =
    profile.linkedin_public_identifier || getLinkedInProfileId(linkedinUrl);
  const name = profile.name || nameFromLinkedInProfileId(profileId) || profileId;
  const cleanUrl = linkedinUrl.replace(/\/?$/, '/');

  return [
    {
      label: 'linkedin_exact_profile',
      query: `"${cleanUrl}"`,
    },
    {
      label: 'linkedin_profile_slug',
      query: `site:linkedin.com/in "${profileId}" "${name}"`,
    },
    {
      label: 'linkedin_india_profile_slug',
      query: `site:in.linkedin.com/in "${profileId}" "${name}"`,
    },
    {
      label: 'linkedin_indexed_experience',
      query: `site:linkedin.com/in "${name}" "${profileId}" "Experience"`,
    },
    {
      label: 'linkedin_indexed_breakdown',
      query: `"${name}" "${profileId}" "worked" OR "experience" OR "founder"`,
    },
    {
      label: 'linkedin_posts_same_slug',
      query: `site:linkedin.com/posts "${profileId}" "${name}"`,
    },
    {
      label: 'linkedin_role_company_dates',
      query: `"${name}" "${profileId}" "company" "present" "20"`,
    },
    {
      label: 'linkedin_public_bios',
      query: `"${name}" "${profileId}" LinkedIn bio experience`,
    },
  ].filter((item) => item.query && !item.query.includes('""'));
}

function buildResearchQueries(scenario, profile) {
  const guardrail = buildIdentityAnchor(scenario, profile);
  const knownCompanies = knownCompaniesFromProfile(profile);

  const queries = [
    {
      label: 'identity',
      query: `${guardrail}

Confirm the person's full name, current role, employer, location, professional
headline, official website, and LinkedIn identity. Note any conflicting facts.`,
    },
    {
      label: 'experience',
      query: `${guardrail}

Find the complete verified work history: company, exact title, location,
responsibilities, start date, and end date. Check official company pages,
interviews, announcements, and professional biographies.`,
    },
    {
      label: 'education',
      query: `${guardrail}

Find verified education, degrees, fields of study, attendance dates,
certifications, and languages. Include a source URL for every claim.`,
    },
    {
      label: 'social_profiles',
      query: `${guardrail}

Find every verified public profile belonging to this person, including X,
GitHub, Medium, DEV, Substack, YouTube, Instagram, Facebook, Product Hunt,
AngelList, personal blogs, and other relevant platforms. Return full URLs and
handles. Exclude profiles that cannot be tied to this exact identity.`,
    },
    {
      label: 'publications',
      query: `${guardrail}

Find articles, blog posts, interviews, podcasts, conference talks, videos, and
other published content authored by or clearly featuring this person. Return
title, platform, date, and URL.`,
    },
    {
      label: 'achievements',
      query: `${guardrail}

Find verified awards, investments, funding announcements, public launches,
volunteering, board positions, notable achievements, and recent professional
news. Include dates, amounts, and source URLs where available.`,
    },
    {
      label: 'company',
      query: `${guardrail}

Research the person's current company: official name, product, industry,
website, LinkedIn page, founding year, founders, headquarters, and employee
size. Separate company facts from facts about the person.`,
    },
  ];

  if (INCLUDE_CONTACT) {
    queries.push(
      {
        label: 'contact_domain',
        query: `${guardrail}

Find publicly displayed professional email addresses for this person using
official company pages, team pages, speaker bios, press releases, or public
profiles. Also find the confirmed company domain. Never generate or infer an
email pattern. Return the exact email and source URL, or "not found".`,
      },
      {
        label: 'contact_phone',
        query: `${guardrail}

Find any publicly displayed professional phone number or direct contact page
for this person. Use official or clearly attributable sources only. Never
guess. Return the exact number/contact URL and source, or "not found".`,
      }
    );
  }

  if (RESEARCH_MODE === 'deep') {
    for (const company of knownCompanies.slice(0, 5)) {
      queries.push({
        label: `company_role_${company}`,
        query: `${guardrail}

Research this person's exact role at "${company}". Find title,
responsibilities, employment dates, announcements, and an authoritative source.
Do not include facts about another person with the same name.`,
      });
    }

    queries.push(
      {
        label: 'alternate_identity_search',
        query: `${guardrail}

Search using combinations of the person's name, company, location, LinkedIn
slug, and known websites to find facts missed by ordinary name searches.
Return only newly verified facts with URLs.`,
      },
      {
        label: 'career_dates_crosscheck',
        query: `${guardrail}

Cross-check all available employment and education dates. Report only dates
explicitly stated by reliable sources and identify contradictions.`,
      }
    );
  }

  return queries;
}

function selectInitialResearchQueries(scenario, profile) {
  if (isSparseLinkedInFallbackProfile(profile)) {
    return buildSparseLinkedInFallbackQueries(profile);
  }

  const experienceQueries = EXPERIENCE_FIRST
    ? buildExperienceFirstQueries(scenario, profile)
    : [];
  const generalQueries = buildResearchQueries(scenario, profile);

  if (!EXPERIENCE_FIRST) {
    return RESEARCH_MODE === 'deep'
      ? generalQueries
      : generalQueries.filter((item) =>
          ['identity', 'experience', 'company'].includes(item.label)
        );
  }

  if (RESEARCH_MODE === 'deep') {
    const companyRoleQueries = experienceQueries
      .filter((item) => item.label.startsWith('experience_company_'))
      .slice(0, 8);
    const baseExperience = experienceQueries.filter(
      (item) => !item.label.startsWith('experience_company_')
    );
    const general = generalQueries.filter((item) =>
      [
        'identity',
        'experience',
        'company',
        'social_profiles',
        'publications',
        'achievements',
      ].includes(item.label)
    );
    return [...baseExperience, ...companyRoleQueries, ...general];
  }

  const baseExperience = experienceQueries.filter(
    (item) => !item.label.startsWith('experience_company_')
  );
  const companyRoleQueries = experienceQueries
    .filter((item) => item.label.startsWith('experience_company_'))
    .slice(0, 3);

  return [...baseExperience, ...companyRoleQueries];
}

// One-job extraction: enumerate every employer the research clearly attributes
// to THIS person. Runs in parallel with full synthesis to recover companies the
// broad synthesis pass drops (it juggles about/skills/education too and tends to
// be conservative on the experience list). No added wall-clock — it overlaps.
async function extractCareerFromResearch(profile, research) {
  if (!research || !String(research).trim()) return [];

  const signals = profileSignals(profile);
  const knownCompanies = knownCompaniesFromProfile(profile, 12);

  try {
    const out = await callJsonAI({
      label: 'experience_extract',
      systemPrompt:
        'You extract employment history from web research. You list ONLY companies clearly attributable to the exact person identified below. You never invent companies and never include directory/data-aggregator sites (RocketReach, Pappers, Stackforce, societe.com, Clutch, etc.) or businesses belonging to a different same-named person.',
      userPrompt: `
Exact person:
- Name: ${signals.name || 'unknown'}
- LinkedIn: ${signals.linkedin_url || 'unknown'}
- Current/known company: ${signals.company || knownCompanies[0] || 'unknown'}
- Location: ${signals.location || 'unknown'}
- Known companies: ${knownCompanies.join(', ') || 'none'}

Enumerate EVERY employer/role attributable to this exact person from the research
below. Be thorough — include older roles, freelance, contract, and author/
contributor roles (e.g. writing for a tech publication) if the research shows them.

IMPORTANT: When a sentence lists multiple employers together — e.g. "Software
Engineer at Toptal, eBay, Rakuten, and Ingenico" or "previous roles at X, Y and Z" —
create a SEPARATE entry for EACH company named. Never collapse a comma/and list
into one entry and never skip the middle items of such a list.

For each company set attribution_confidence: "high" if a source ties it directly to
this person (matching LinkedIn slug, GitHub, their site, or a clearly-this-person
bio), "medium" if strongly implied, "low" if uncertain. Set fields to null when not
stated. Do NOT include data-aggregator/directory sites as employers.

Research:
${trimText(research, 24000)}
`.trim(),
      schema: EXPERIENCE_EXTRACT_SCHEMA,
      maxTokens: 2500,
      models: PLANNER_MODELS,
    });
    return Array.isArray(out.companies) ? out.companies : [];
  } catch (error) {
    console.warn(`  Experience extraction failed: ${error.message}`);
    return [];
  }
}

async function planExperienceFollowups(scenario, profile, firstPassResearch) {
  if (!EXPERIENCE_FIRST || RESEARCH_MODE === 'off') {
    return { likely_missing_roles: [], follow_up_queries: [] };
  }

  const signals = profileSignals(profile);
  const knownCompanies = knownCompaniesFromProfile(profile, 12);
  const prompt = `
We are enriching a LinkedIn profile where public mode may show only part of the
experience section. The first research pass below may contain results from
Scrapingdog AI Mode, Perplexity, and other web-search providers.

Your task:
1. Identify likely missing experience entries or grouped sub-roles.
2. Generate high-precision research follow-up queries to verify those missing
   roles. These queries may be run through AI Mode, Perplexity, or another
   web-search provider.
3. Focus only on work experience. Ignore education/contact/social unless it
   helps disambiguate employment.

Identity:
- Name: ${signals.name || 'unknown'}
- LinkedIn: ${signals.linkedin_url || 'unknown'}
- Current role: ${signals.role || 'unknown'}
- Current/known company: ${signals.company || knownCompanies[0] || 'unknown'}
- Location: ${signals.location || 'unknown'}
- Known companies from baseline: ${knownCompanies.join(', ') || 'none'}
- Scenario: ${scenario}

Baseline visible experience:
${JSON.stringify(profile.experience || [])}

First-pass mixed-provider research:
${trimText(firstPassResearch, 45000)}

Return:
- likely_missing_roles: suspected company/title/date clues worth verifying.
- follow_up_queries: 4-12 exact queries. Each query must include the person's
  name plus at least one disambiguator: LinkedIn URL, known company, location,
  or a distinctive current role. Make queries specific enough to avoid
  same-name results.
`.trim();

  const plan = await callJsonAI({
    label: 'experience_followup_plan',
    systemPrompt: EXPERIENCE_SYSTEM_PROMPT,
    userPrompt: prompt,
    schema: EXPERIENCE_PLAN_SCHEMA,
    maxTokens: 2500,
    models: PLANNER_MODELS,
  });

  return {
    likely_missing_roles: (plan.likely_missing_roles || []).slice(0, 20),
    follow_up_queries: (plan.follow_up_queries || []).slice(
      0,
      EXPERIENCE_FOLLOWUP_LIMIT
    ),
  };
}

// Highest-signal AI Mode query labels — these surface LinkedIn-indexed rows
// that Perplexity's general web search misses. When the Perplexity boost runs in
// parallel (it covers timeline/github/press), we only need these from AI Mode,
// trimming the initial wave to one concurrency batch and cutting wall-clock time.
const AI_MODE_PRIORITY_LABELS = [
  'linkedin_profile_recovery',
  'experience_complete_breakdown',
  'experience_linkedin_indexed',
  'experience_indexed_rows',
  'experience_personal_website',
];

// Hard latency cap per parallel boost call. perplexity/sonar usually returns in
// 8-14s; a straggler past this is dropped so it can't dominate wall-clock time.
const PERPLEXITY_BOOST_TIMEOUT_MS = Number(
  process.env.PERPLEXITY_BOOST_TIMEOUT_MS || 14000
);
// Each Perplexity boost angle is a paid sonar call (~$0.006) and is ~93% of the
// per-run OpenRouter cost. Default to 1 (the high-value timeline angle) to keep
// cost low; the supplementary github/press angles mostly added cost + same-name
// noise. Bump PERPLEXITY_BOOST_ANGLES to 2-3 if you want broader recall.
const PERPLEXITY_BOOST_ANGLES = Math.max(
  1,
  Math.min(3, Number(process.env.PERPLEXITY_BOOST_ANGLES || 1))
);

// Race a promise against a timeout; reject (not hang) when it overruns so the
// caller's .catch() drops that single result and the run proceeds.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${(ms / 1000).toFixed(0)}s`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function collectResearch(scenario, profile) {
  if (RESEARCH_MODE === 'off') return '';

  // Unverifiable no-anchor profiles (private, low-profile, common-name): public
  // research returns a DIFFERENT same-named person each run and we discard it
  // anyway (gateSameNameExperience). Skip the whole research phase — it's wasted
  // OpenRouter spend and time. Prominent public figures are exempt (researched
  // normally); ALLOW_UNANCHORED_EXPERIENCE=true forces research for anyone.
  if (scenario === 2 && isUnverifiableNoAnchorProfile(profile)) {
    console.log(
      '  No company anchor + low profile — skipping research (would be discarded as unverifiable same-name data). Returns baseline + low confidence.'
    );
    return '';
  }

  let queries = selectInitialResearchQueries(scenario, profile);

  // When the Perplexity boost will run in parallel and the profile is sparse,
  // trim the AI Mode wave to the highest-signal LinkedIn-indexed queries plus
  // any per-company deep-dives. Everything else is redundant with the boost.
  const willBoost =
    shouldRunExperienceFollowup(profile) &&
    SEARCH_FALLBACK.includes('perplexity') &&
    RESEARCH_MODE !== 'deep' &&
    process.env.AI_MODE_TRIM !== 'false';
  if (willBoost && queries.length > AI_MODE_CONCURRENCY) {
    const priority = queries.filter(
      (q) =>
        AI_MODE_PRIORITY_LABELS.includes(q.label) ||
        q.label.startsWith('experience_company_')
    );
    if (priority.length) {
      console.log(
        `  Trimming AI Mode wave from ${queries.length} to ${priority.length} high-signal queries (Perplexity boost covers the rest).`
      );
      queries = priority;
    }
  }

  console.log(
    `  Running ${queries.length} focused research queries in parallel...`
  );
  console.log(
    `  AI Mode budget: ${AI_MODE_MAX_CALLS < 0 ? 'unlimited' : AI_MODE_MAX_CALLS}; fallback order: ${SEARCH_FALLBACK}`
  );
  console.log(
    `  AI Mode concurrency: ${AI_MODE_CONCURRENCY}; retries: ${AI_MODE_RETRIES}`
  );
  console.log(
    `  Perplexity batch mode: ${PERPLEXITY_BATCH_MODE ? `on, size ${PERPLEXITY_BATCH_SIZE}` : 'off'}`
  );

  // For sparse-baseline profiles, fire a Perplexity career overview IN PARALLEL
  // with the AI Mode wave. Perplexity finishes in ~3-7s; AI Mode takes ~15-25s,
  // so this adds zero wall-clock time while providing a reliable career anchor.
  const usePerplexityBoost =
    shouldRunExperienceFollowup(profile) && SEARCH_FALLBACK.includes('perplexity');

  let perplexityBoostPromise = Promise.resolve(null);
  if (usePerplexityBoost) {
    const sig = profileSignals(profile);
    const boostName = sig.name || 'unknown';
    const boostUrl = sig.linkedin_url || boostName;
    const boostAnchor = buildIdentityAnchor(scenario, profile);
    // Three complementary angles. Running them as 3 PARALLEL single-angle calls
    // (instead of one batch doing 3 sequential web searches) cuts latency from
    // ~30s to the slowest single call (~12-15s) — the boost is the long pole.
    const domain = (sig.linkedin_url || '')
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    // Identity descriptor built from the ACTUAL profile (role/headline/company/
    // location), not a hardcoded industry — works for any field (tech, finance,
    // wealth planning, etc.) and sharpens same-name disambiguation.
    const personBits = [
      sig.role ? `role: ${sig.role}` : '',
      sig.company ? `company: ${sig.company}` : '',
      sig.location ? `location: ${sig.location}` : '',
    ].filter(Boolean);
    const personDescriptor = personBits.length
      ? ` (${personBits.join('; ')})`
      : '';

    // The timeline angle is the backbone (the full employer list), so it gets a
    // longer leash. The supplementary angles are best-effort with a tighter cap.
    const noiseGuard = `CRITICAL: Multiple different people may share the name "${boostName}". Only report roles for the SPECIFIC person at ${boostUrl}${personDescriptor}. Match identity using the LinkedIn URL, current company, and location. EXCLUDE anything from business-registry or company-director databases (societe.com, pappers, infogreffe, rocketreach, zoominfo, etc.) and EXCLUDE businesses that don't match this person's actual field/location. When unsure whether a company belongs to THIS exact person, OMIT it — a missing company is far better than a wrong one.`;
    const allBoostItems = [
      {
        label: 'career_full_timeline',
        timeout: PERPLEXITY_BOOST_TIMEOUT_MS + 2000,
        query: `${noiseGuard}

List the employers and roles ${boostName}${personDescriptor} (LinkedIn: ${boostUrl}) has held, most recent to oldest.
For each: exact company name (use subsidiary/brand names where applicable), job title, start date, end date or "Present", location, role description if explicitly stated.
Include freelance, contract, and older roles. Return source URLs.`,
      },
      {
        label: 'career_github_and_site',
        timeout: PERPLEXITY_BOOST_TIMEOUT_MS,
        query: `${noiseGuard}

Search "${boostName}" on their personal website/blog/CV page, GitHub, and professional bios.
List every employer or company mentioned, with role and dates if stated. Return source URLs.`,
      },
      {
        label: 'career_press_and_mentions',
        timeout: PERPLEXITY_BOOST_TIMEOUT_MS,
        query: `${noiseGuard}

Find press releases, interviews, news articles, or podcast appearances mentioning ${boostName}${personDescriptor} (${boostUrl}).
List every company or employer named, with the role or context. Return source URLs.`,
      },
    ];
    const boostItems = allBoostItems.slice(0, PERPLEXITY_BOOST_ANGLES);
    console.log(
      `  Starting ${boostItems.length} parallel Perplexity career-boost search(es)...`
    );
    perplexityBoostPromise = Promise.all(
      boostItems.map((it) =>
        withTimeout(
          perplexitySearch(`${boostAnchor}\n\n${it.query}`),
          it.timeout,
          `boost ${it.label}`
        )
          .then((r) => (r ? `[${it.label}]\n${r}` : null))
          .catch((err) => {
            console.warn(`  Perplexity boost (${it.label}) ${err.message}`);
            return null;
          })
      )
    ).then((parts) => {
      const merged = parts.filter(Boolean).join('\n\n');
      return merged || null;
    });
  }

  // Deterministically fetch the person's own website in parallel — it's the most
  // authoritative public source for the employer list and can't be same-name
  // confused. Runs alongside the AI Mode + boost waves, so no added wall-clock.
  const websiteUrl = profile.website || '';
  const websitePromise = websiteUrl
    ? fetchWebsiteText(websiteUrl)
    : Promise.resolve('');

  const [results, perplexityBoost, websiteText] = await Promise.all([
    runResearchQueries(queries, 0, profile),
    perplexityBoostPromise,
    websitePromise,
  ]);

  let combined = results
    .filter(({ result }) => result)
    .map(({ label, result }) => `[${label}]\n${result}`)
    .join('\n\n');

  // Prepend the website text as a high-authority block (capped — it's raw HTML
  // text). This guarantees website-listed employers are always in the evidence.
  if (websiteText && websiteText.length > 80) {
    console.log(
      `  Fetched personal website (${websiteText.length} chars) — adding as authoritative source.`
    );
    combined = `[personal_website_direct] (AUTHORITATIVE — the person's own site: ${websiteUrl})\n${trimText(websiteText, 6000)}\n\n${combined}`;
  }

  let boostWasUseful = false;
  if (perplexityBoost && isUsefulResearchResult(perplexityBoost)) {
    console.log('  Perplexity career-boost returned useful data — prepending to research.');
    combined = `[perplexity_career_boost]\n${perplexityBoost}\n\n${combined}`;
    boostWasUseful = true;
  }

  if (!EXPERIENCE_FIRST) {
    return trimText(combined, MAX_TOTAL_RESEARCH_CHARS);
  }

  if (isSparseLinkedInFallbackProfile(profile) && !PRIVATE_PROFILE_FOLLOWUPS) {
    console.warn(
      '  LinkedIn API fallback profile. Skipping private-profile follow-up planning.'
    );
    return trimText(combined, MAX_TOTAL_RESEARCH_CHARS);
  }

  if (isSparseLinkedInFallbackProfile(profile) && !combined) {
    console.warn(
      '  No anchored private-profile evidence found. Skipping follow-up planning.'
    );
    return '';
  }

  // Skip the planner + second research wave if the profile already has enough
  // roles from the LinkedIn API, or if the env explicitly disables it.
  if (!shouldRunExperienceFollowup(profile)) {
    console.log(
      '  Skipping follow-up research pass (baseline has enough roles or disabled).'
    );
    return trimText(combined, MAX_TOTAL_RESEARCH_CHARS);
  }

  // The Perplexity career-boost (3 angles) already covers the same ground the
  // planner + AI Mode follow-up wave would — and it ran in parallel for free.
  // When it returned useful data, skip the planner LLM call (~5s) and the
  // follow-up AI Mode wave (~20-30s). This is the single biggest latency win.
  if (boostWasUseful && process.env.EXPERIENCE_FOLLOWUP_FORCE !== 'true') {
    console.log(
      '  Perplexity career-boost covered follow-up needs — skipping planner + second AI Mode wave.'
    );
    return trimText(combined, MAX_TOTAL_RESEARCH_CHARS);
  }

  console.log('  Planning experience follow-up searches...');
  const plan = await planExperienceFollowups(scenario, profile, combined);
  const followups = plan.follow_up_queries || [];

  if (!followups.length) {
    return trimText(combined, MAX_TOTAL_RESEARCH_CHARS);
  }

  console.log(
    `  Running ${followups.length} second-pass experience searches...`
  );

  const followupResults = await runResearchQueries(
    followups.map((item, index) => ({
      label: item.label || `experience_followup_${index + 1}`,
      query: item.query,
    })),
    queries.length,
    profile
  );

  const missingRoleHints = plan.likely_missing_roles?.length
    ? `[experience_planner_hints]\n${JSON.stringify(plan.likely_missing_roles)}`
    : '';

  const followupBlock = followupResults
    .filter(({ result }) => result)
    .map(({ label, result }) => `[${label}]\n${result}`)
    .join('\n\n');

  return trimText(
    [combined, missingRoleHints, followupBlock].filter(Boolean).join('\n\n'),
    MAX_TOTAL_RESEARCH_CHARS
  );
}

// ---------------------------------------------------------------------------
// FINAL SYNTHESIS
// ---------------------------------------------------------------------------
function buildSynthesisPrompt(scenario, profile, research) {
  const sourceLabel =
    research
      ? 'enriched'
      : scenario === 2
        ? 'scraped'
        : scenario === 3
          ? 'ai_knowledge'
          : 'enriched';

  // Only the most recent roles go to the model (it adds descriptions + about);
  // the full experience list is restored deterministically after synthesis, so
  // capping here bounds latency on very rich profiles without dropping roles.
  const fullExperience = Array.isArray(profile.experience)
    ? profile.experience
    : [];
  const trimmedProfile =
    fullExperience.length > SYNTHESIS_EXPERIENCE_LIMIT
      ? { ...profile, experience: fullExperience.slice(0, SYNTHESIS_EXPERIENCE_LIMIT) }
      : profile;
  const experienceNote =
    fullExperience.length > SYNTHESIS_EXPERIENCE_LIMIT
      ? `\nNote: only the ${SYNTHESIS_EXPERIENCE_LIMIT} most recent of ${fullExperience.length} roles are shown; older roles are retained automatically, so focus on these.`
      : '';

  return `
Create the final professional profile from the compact baseline and optional
live research below.

Scenario:
${scenario}

Required data_source:
${sourceLabel}

Baseline profile:
${JSON.stringify(trimmedProfile)}${experienceNote}

Live research:
${research || 'No live research was performed.'}

Instructions:
- EXPERIENCE IS THE MOST IMPORTANT FIELD. Spend most of your effort there.
- The final experience array should be as complete as the evidence allows,
  including ALL companies mentioned in both the baseline and research. Do not
  drop companies just because dates or descriptions are missing.
- If the baseline experience array contains entries with a company name but null
  title, those companies are LinkedIn-verified employers. Find their role in
  research and include them in the experience section.
- For each experience entry, use the most specific title, company, location,
  date range, duration, company_url, company_linkedin_id, and description
  supported by baseline or research.
- Use the EXACT company name found in the research. If the research says
  "Rakuten Kobo" use "Rakuten Kobo", not "Rakuten". If it says "Accenture
  France" use "Accenture France", not "Accenture". Subsidiaries and brands
  matter — do not generalize to parent companies.
- When only a company/title is verified but dates are not, include the role with
  null dates instead of dropping it.
- Never include an experience entry with a null title. A company-only hint is
  not an experience record.
- Never add duplicate company-only entries when a detailed role already exists
  for that company.
- Never write speculative, hedged, or generic descriptions. Prohibited
  words/phrases: "likely", "probably", "possibly", "may have", "might have",
  "appears to", "seems to", "could have", "presumably", "implies", "suggests",
  "likely involved", "likely worked", "contributed to projects".
  A description must quote or closely paraphrase a specific fact stated in
  the research text. If no such specific fact exists, set description to null.
  Do NOT rephrase general knowledge or restate the job title.
- Do not collapse multiple roles at the same company if the evidence supports
  separate titles or promotions.
- Preserve all verified baseline facts.
- Use live research only when it clearly matches the same person.
- If baseline profile_source is linkedin_api_fallback, treat name-only matches as
  unsafe. Use facts only when accepted source references contain the exact
  LinkedIn URL/slug.
- If baseline profile_source is linkedin_api_fallback, LinkedIn posts and profile
  headlines verify identity only. Do not create experience entries from posts,
  followers, creator activity, bios, or headline text unless research explicitly
  shows a work-experience role with company/title/date evidence.
- For private or non-indexed LinkedIn profiles with weak evidence, keep
  confidence_score="low", avoid filling uncertain experience, and list missing
  fields instead of borrowing another person's data.
- Build detailed experience descriptions only from supplied or sourced facts.
- Preserve company_url/company LinkedIn URLs and company_linkedin_id for
  experience entries whenever present in baseline or research. Derive
  company_linkedin_id from the LinkedIn company/school URL slug when possible.
- Skills may be conservatively inferred from verified roles and activities.
- Do not invent contact information, dates, URLs, education, or employers.
- If contact research was disabled, keep email and phone null unless they were
  already present in the baseline.
- Keep arrays deduplicated and ordered by relevance or recency.
- Populate missing_fields after all other fields are complete.
`.trim();
}

// Print the full result to the console. Only write a file when OUTPUT_FILE is set.
function emitResult(result) {
  const json = JSON.stringify(result, null, 2);
  console.log('\n===== RESULT (JSON) =====');
  console.log(json);
  if (OUTPUT_FILE) {
    fs.writeFileSync(OUTPUT_FILE, json);
    console.log(`\n(Also saved to ${OUTPUT_FILE})`);
  }
}

// Deterministically guarantee the real LinkedIn profile's experience (roles +
// descriptions) and summary survive synthesis. A fast synthesis model is quick
// but can drop descriptions, whole roles, or the about text; this restores them
// from ground truth so the experience section stays accurate and complete no
// True when the LinkedIn baseline gives at least one real company name to anchor
// identity. Empty/censored companies (private profiles) don't count.
function hasBaselineCompanyAnchor(profile) {
  return (profile.experience || []).some(
    (e) => e.company && String(e.company).trim() && !/^\*+$/.test(e.company)
  );
}

// Parse a LinkedIn follower/connection string ("56K followers", "1,205", "2M")
// into a number.
function parseSocialCount(value) {
  if (!value) return 0;
  const m = String(value).match(/([\d][\d.,]*)\s*([KkMm])?/);
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (Number.isNaN(n)) return 0;
  const suffix = (m[2] || '').toLowerCase();
  return Math.round(n * (suffix === 'm' ? 1e6 : suffix === 'k' ? 1e3 : 1));
}

// A profile with no company anchor is risky for same-name contamination. But a
// PROMINENT person (many followers) is a public figure whose career research
// reliably identifies the right person (e.g. a government minister), so we still
// research them. Only low-profile, no-anchor, private profiles are unverifiable.
function isUnverifiableNoAnchorProfile(profile) {
  if (hasBaselineCompanyAnchor(profile)) return false;
  if (process.env.ALLOW_UNANCHORED_EXPERIENCE === 'true') return false;
  if (parseSocialCount(profile.followers) >= PROMINENCE_FOLLOWERS) return false;
  return true;
}

// Identity gate for same-name contamination. Common-name private profiles (no
// company anchor, e.g. "Aaron Smith" in a small village) make web research pull
// in a DIFFERENT, more-prominent same-named person's employers — and a different
// stranger each run. We cannot verify identity from public data here (the search
// providers even echo the name/location we pass them), so the honest default is
// to NOT show unverifiable experience: keep only baseline-anchored companies and
// mark confidence low. Set ALLOW_UNANCHORED_EXPERIENCE=true to keep best-effort
// guesses (clearly low-confidence) instead.
function gateSameNameExperience(result, profile, research) {
  if (hasBaselineCompanyAnchor(profile)) return result; // anchored — trust pipeline
  // No anchor but prominent/opted-in: research is reliable enough to keep, but
  // still mark low confidence since there's no baseline company to verify against.
  if (!isUnverifiableNoAnchorProfile(profile)) {
    return { ...result, confidence_score: 'low' };
  }

  const baselineKeys = new Set(
    (profile.experience || [])
      .map((e) => normalizedCompanyKey(e.company))
      .filter(Boolean)
  );
  const exp = Array.isArray(result.experience) ? result.experience : [];
  const safe = exp.filter((e) => baselineKeys.has(normalizedCompanyKey(e.company)));
  if (safe.length < exp.length) {
    console.log(
      `  No baseline company anchor + common-name risk — dropping ${exp.length - safe.length} unverifiable same-name compan${exp.length - safe.length === 1 ? 'y' : 'ies'} (can't confirm it's this exact person). Set ALLOW_UNANCHORED_EXPERIENCE=true to keep best-effort guesses.`
    );
  }
  const missing =
    !safe.length && Array.isArray(result.missing_fields)
      ? Array.from(new Set([...result.missing_fields, 'experience']))
      : result.missing_fields;
  return {
    ...result,
    experience: safe,
    confidence_score: 'low',
    missing_fields: missing,
  };
}

// matter which model ran. No-op for sparse/failed-profile runs (no baseline).
// Deterministic anti-hallucination guard. A fast synthesis model occasionally
// invents a company (e.g. "Disruptive Synergies LLC") with a fabricated
// LinkedIn slug. Drop any experience entry whose company name appears NOWHERE
// in the research evidence or the LinkedIn baseline — those are inventions, not
// findings. Baseline-verified companies are always kept.
function dropHallucinatedCompanies(result, profile, research) {
  if (!Array.isArray(result.experience) || !result.experience.length) {
    return result;
  }

  const evidence = normalizedText(`${research || ''} ${profile.about || ''}`);
  const baselineKeys = new Set(
    (profile.experience || [])
      .map((e) => normalizedCompanyKey(e.company))
      .filter(Boolean)
  );

  // Directory/ranking/aggregator sites a profile gets LISTED on — never real
  // employers. Synthesis sometimes mistakes "company X is ranked on Y" for a job.
  const NON_EMPLOYER_PATTERN =
    /(\btop\s+\d*\s*(interactive\s+)?(agenc|compan|developer|firm)|\bbest\s+\w+\s+(agenc|compan)|\b(clutch|goodfirms|designrush|crunchbase|rocketreach|pappers|societe|stackforce|glassdoor|indeed|trustpilot|directory|ranking|listicle)\b)/i;
  // Placeholder/junk company names a model emits when it has no real value.
  const JUNK_COMPANY_PATTERN =
    /^(unspecified|unknown|undisclosed|various|n\/?a|none|not\s+(specified|available|found)|company|employer|self[\s-]?employed|freelance|independent|auto[\s-]?entrepreneur|auto[\s-]?entrepreneurship)\b/i;

  const kept = [];
  const dropped = [];
  for (const entry of result.experience) {
    const company = entry.company || '';
    const key = normalizedCompanyKey(company);
    // Keep if it's a baseline-verified employer.
    if (key && baselineKeys.has(key)) {
      kept.push(entry);
      continue;
    }
    // Drop obvious directory/ranking sites and junk placeholder names.
    if (NON_EMPLOYER_PATTERN.test(company) || JUNK_COMPANY_PATTERN.test(company.trim())) {
      dropped.push(company);
      continue;
    }
    // Keep if the company name (or its core token) appears in the evidence text.
    const core = key.split(' ')[0] || '';
    const appears =
      (company && evidence.includes(normalizedText(company))) ||
      (key && evidence.includes(key)) ||
      (core.length >= 4 && evidence.includes(core));
    if (appears) {
      kept.push(entry);
    } else {
      dropped.push(company);
    }
  }

  if (dropped.length) {
    console.log(
      `  Dropped ${dropped.length} unverifiable (hallucinated) compan${dropped.length === 1 ? 'y' : 'ies'}: [${dropped.join(', ')}]`
    );
  }

  const finalExp = kept.length ? kept : result.experience;

  // Dedup by company (synthesis can emit the same employer twice under slightly
  // different titles, e.g. "Co-Founder" + "CEO"). Merge into the richest entry.
  const fieldScore = (e) =>
    ['title', 'description', 'start_date', 'end_date', 'location', 'company_url', 'company_linkedin_id']
      .filter((f) => e[f]).length;
  const byCompany = new Map();
  for (const entry of finalExp) {
    const key = normalizedCompanyKey(entry.company);
    if (!key) {
      byCompany.set(Symbol(), entry); // keep unkeyed entries as-is
      continue;
    }
    const existing = byCompany.get(key);
    if (!existing) {
      byCompany.set(key, entry);
      continue;
    }
    // Merge: prefer the richer entry, backfill missing fields from the other.
    const [rich, lean] =
      fieldScore(entry) >= fieldScore(existing) ? [entry, existing] : [existing, entry];
    byCompany.set(key, {
      ...rich,
      description: rich.description || lean.description,
      start_date: rich.start_date || lean.start_date,
      end_date: rich.end_date || lean.end_date,
      location: rich.location || lean.location,
      company_url: rich.company_url || lean.company_url,
      company_linkedin_id: rich.company_linkedin_id || lean.company_linkedin_id,
    });
  }

  const deduped = Array.from(byCompany.values());
  if (deduped.length < finalExp.length) {
    console.log(
      `  Merged ${finalExp.length - deduped.length} duplicate company entr${finalExp.length - deduped.length === 1 ? 'y' : 'ies'}.`
    );
    if (process.env.DEBUG_DEDUP) {
      console.log(
        `  [debug] before: [${finalExp.map((e) => e.company).join(', ')}]`
      );
      console.log(
        `  [debug] after:  [${deduped.map((e) => e.company).join(', ')}]`
      );
    }
  }

  return { ...result, experience: deduped };
}

// Union extracted companies into the synthesized experience. The focused
// extraction pass is more thorough at enumeration, so it recovers companies the
// broad synthesis dropped. Only entries with a title and decent attribution are
// added; existing companies are left untouched (synthesis descriptions win).
function mergeExtractedCompanies(result, extracted) {
  if (!Array.isArray(extracted) || !extracted.length) return result;

  const experience = Array.isArray(result.experience) ? [...result.experience] : [];
  const existingKeys = new Set(
    experience.map((e) => normalizedCompanyKey(e.company)).filter(Boolean)
  );

  const JUNK = /^(unspecified|unknown|undisclosed|various|n\/?a|none|not\s+(specified|available|found)|company|employer)\b/i;
  const added = [];
  for (const item of extracted) {
    const entry = cleanExperienceEntry(item);
    if (!entry.company || !entry.title) continue; // need a real role
    if (JUNK.test(entry.company.trim())) continue; // placeholder junk
    if ((item.attribution_confidence || 'low') === 'low') continue; // too risky
    const key = normalizedCompanyKey(entry.company);
    if (!key || existingKeys.has(key)) continue;
    existingKeys.add(key);
    experience.push(entry);
    added.push(entry.company);
  }

  if (added.length) {
    console.log(
      `  Recovered ${added.length} compan${added.length === 1 ? 'y' : 'ies'} from focused extraction: [${added.join(', ')}]`
    );
  }

  return { ...result, experience };
}

function preserveBaselineData(result, profile) {
  const baseline = (profile.experience || [])
    .map(cleanExperienceEntry)
    .filter((entry) => entry.company && entry.title);

  // Restore the real LinkedIn summary if synthesis left about empty.
  let about = result.about;
  if ((!about || !String(about).trim()) && profile.about) {
    about = profile.about;
  }

  if (!baseline.length) {
    return reconcileMissingFields({ ...result, about });
  }

  const keyOf = (entry) =>
    `${normalizedText(entry.company)}|${normalizedText(entry.title)}`;
  const resultExp = (result.experience || []).map(cleanExperienceEntry);
  const byKey = new Map(resultExp.map((entry) => [keyOf(entry), entry]));
  const used = new Set();
  const merged = [];

  // 1. Every real role survives, with ground-truth description/dates preferred.
  for (const base of baseline) {
    const key = keyOf(base);
    used.add(key);
    const match = byKey.get(key);
    if (!match) {
      merged.push(base);
      continue;
    }
    merged.push({
      ...match,
      description: base.description || match.description,
      start_date: match.start_date || base.start_date,
      end_date: match.end_date || base.end_date,
      location: match.location || base.location,
      company_linkedin_id: match.company_linkedin_id || base.company_linkedin_id,
    });
  }

  // 2. Keep any extra roles synthesis/research legitimately added.
  for (const entry of resultExp) {
    if (!used.has(keyOf(entry))) merged.push(entry);
  }

  // 3. Company-only LinkedIn API entries (title=null) are verified employers.
  //    They can't anchor a full role but their company_url/linkedin_id are
  //    authoritative — backfill those fields into any matching merged entry.
  const companyAnchors = (profile.experience || [])
    .map(cleanExperienceEntry)
    .filter((e) => e.company && !e.title && (e.company_url || e.company_linkedin_id));

  if (companyAnchors.length) {
    const anchorByKey = new Map(
      companyAnchors.map((a) => [normalizedCompanyKey(a.company), a])
    );
    for (let i = 0; i < merged.length; i++) {
      const anchor = anchorByKey.get(normalizedCompanyKey(merged[i].company));
      if (!anchor) continue;
      merged[i] = {
        ...merged[i],
        company_url: merged[i].company_url || anchor.company_url,
        company_linkedin_id: merged[i].company_linkedin_id || anchor.company_linkedin_id,
      };
    }
  }

  return reconcileMissingFields({ ...result, about, experience: merged });
}

// Final pass: tidy every human-readable text field so the output is clean and
// well-formatted (no leftover newlines / ragged whitespace from the scrape),
// not just the company field.
function formatProfileOutput(result) {
  const cleanStrArray = (arr) =>
    Array.isArray(arr) ? arr.map(tidyText).filter(Boolean) : arr;

  const HEDGE_PATTERN =
    /\b(likely|probably|possibly|may have|might have|appears to|seems to|could have|presumably|implies|implied|suggests|suggesting|likely involved|likely worked|contributed to projects)\b/i;

  const experience = Array.isArray(result.experience)
    ? result.experience.map((entry) => {
        const desc = tidyText(entry.description);
        return {
          ...entry,
          company: cleanCompanyName(entry.company, entry.title),
          title: tidyText(entry.title),
          location: tidyText(entry.location),
          description: desc && HEDGE_PATTERN.test(desc) ? null : desc,
        };
      })
    : result.experience;

  const education = Array.isArray(result.education)
    ? result.education.map((entry) => ({
        ...entry,
        institution: tidyText(entry.institution),
        degree: tidyText(entry.degree),
        field: tidyText(entry.field),
      }))
    : result.education;

  return {
    ...result,
    name: tidyText(result.name),
    headline: tidyText(result.headline),
    current_company: tidyText(result.current_company),
    current_role: tidyText(result.current_role),
    location: tidyText(result.location),
    about: tidyText(result.about),
    experience,
    education,
    skills: cleanStrArray(result.skills),
    languages: cleanStrArray(result.languages),
  };
}

// Keep missing_fields honest after we restore about/experience deterministically.
function reconcileMissingFields(result) {
  if (!Array.isArray(result.missing_fields)) return result;
  let missing = result.missing_fields;
  if (result.about && String(result.about).trim()) {
    missing = missing.filter((field) => field !== 'about');
  }
  if ((result.experience || []).length) {
    missing = missing.filter(
      (field) => field !== 'experience' && field !== 'current_role' && field !== 'current_company'
    );
  }
  return { ...result, missing_fields: missing };
}

// Phase stopwatch: each call prints the time since the previous call, so every
// run shows exactly where its seconds went (profile vs research vs synthesis).
function phaseTimer() {
  let last = Date.now();
  return (label) => {
    const now = Date.now();
    console.log(`  [phase] ${label}: ${((now - last) / 1000).toFixed(1)}s`);
    last = now;
  };
}

async function main() {
  console.log(`\nProfile Enricher - Scenario ${SCENARIO}`);
  console.log(`Research mode: ${RESEARCH_MODE}`);
  console.log(`Contact research: ${INCLUDE_CONTACT ? 'enabled' : 'disabled'}\n`);
  console.log(`Planner models: ${PLANNER_MODELS.join(' -> ')}`);
  console.log(`Synthesis models: ${SYNTHESIS_MODELS.join(' -> ')}\n`);

  const mark = phaseTimer();
  let compact;

  if (SCENARIO === 1) {
    compact = compactExistingProfile(EXISTING_PROFILE);
  } else if (SCENARIO === 2) {
    console.log('  Fetching LinkedIn profile...');
    compact = await fetchLinkedInProfileOrFallback(LINKEDIN_URL);
  } else if (SCENARIO === 3) {
    compact = {
      name: `${FIRST_NAME} ${LAST_NAME}`.trim(),
      current_company: COMPANY_NAME,
      current_role: null,
      location: null,
      linkedin_url: null,
      website: null,
      about: null,
      skills: [],
      education: [],
      experience: [],
      activities: [],
    };
  } else {
    throw new Error('SCENARIO must be 1, 2, or 3');
  }

  const baselineRoles = validExperienceCount(compact);
  console.log(
    `  Baseline: ${compact.profile_source || 'n/a'}, ${baselineRoles} experience role(s)`
  );

  mark('profile fetch / baseline');

  const research = await collectResearch(SCENARIO, compact);

  if (process.env.DUMP_RESEARCH) {
    fs.writeFileSync(process.env.DUMP_RESEARCH, research || '');
    console.log(`  [debug] research dumped to ${process.env.DUMP_RESEARCH}`);
  }

  mark('research');

  if (
    isSparseLinkedInFallbackProfile(compact) &&
    !hasAcceptedPrivateProfileResearch(research, compact)
  ) {
    const result = buildProfileNotFoundResult(compact);

    console.log(
      '  Identity verification failed. Returning profile_not_found before synthesis.'
    );
    emitResult(result);
    console.log('\nDone.');
    console.log(`  Status: ${result.status}`);
    console.log(`  Error: ${result.error}`);
    console.log(`  Name: ${result.name || '-'}`);
    console.log(
      `  Calls: ${METRICS.linkedin_api_calls} LinkedIn, ` +
        `${METRICS.scrapingdog_ai_calls} AI Mode, ` +
        `${METRICS.perplexity_search_calls} Perplexity, ` +
        `${METRICS.openrouter_search_calls} OpenRouter search, ` +
        `${METRICS.openrouter_calls} OpenRouter total`
    );
    console.log(`  LinkedIn API failures: ${METRICS.linkedin_api_failures}`);
    console.log(`  AI Mode failures: ${METRICS.scrapingdog_ai_failures}`);
    console.log(`  OpenRouter cost: $${METRICS.openrouter_cost.toFixed(6)}`);
    return;
  }

  // Sparse profiles (no baseline company + no research) legitimately yield an
  // empty experience array — allow it instead of erroring out.
  const allowEmpty =
    SCENARIO === 2 && !hasBaselineCompanyAnchor(compact) && !research;

  // Run full synthesis and the focused company-extraction pass concurrently so
  // the extra completeness costs ~0 wall-clock time (extraction overlaps).
  let prompt = buildSynthesisPrompt(SCENARIO, compact, research);
  const extractPromise = extractCareerFromResearch(compact, research);
  let result = await callStructuredAI(prompt, allowEmpty);
  const extractedCompanies = await extractPromise;
  if (process.env.DEBUG_EXTRACT) {
    console.log(
      `  [debug] extracted: ${JSON.stringify(extractedCompanies.map((c) => `${c.company} (${c.attribution_confidence})`))}`
    );
  }
  result = sanitizePrivateFallbackResult(result, compact, research);
  result = sanitizePrivateFallbackExperience(result, compact, research);
  result = sanitizeLowEvidenceBaselineResult(result, compact, research);

  // Restore the real profile's experience BEFORE the rescue check. A fast model
  // can emit fewer rows than the profile actually has; preserving first means the
  // experience is already complete, so the costly rescue research + re-synthesis
  // is correctly skipped for rich profiles (this was the ~40s spike on big
  // profiles). Idempotent, so it runs again at the end for the rescue path.
  result = preserveBaselineData(result, compact);

  mark('synthesis');

  if (
    shouldRescueExperience(result, compact) &&
    hasAcceptedPrivateProfileResearch(research, compact)
  ) {
    const rescueResearch = await rescueExperienceResearch(compact, result, research);
    if (rescueResearch) {
      const rescuedResearch = [research, `[experience_rescue]\n${rescueResearch}`]
        .filter(Boolean)
        .join('\n\n');
      prompt = buildSynthesisPrompt(SCENARIO, compact, rescuedResearch);
      result = await callStructuredAI(prompt);
      result = sanitizePrivateFallbackResult(result, compact, rescuedResearch);
      result = sanitizePrivateFallbackExperience(result, compact, rescuedResearch);
      result = sanitizeLowEvidenceBaselineResult(result, compact, rescuedResearch);
    }
  }

  // Guarantee the real profile's experience + descriptions + about survive,
  // regardless of which (fast) synthesis model ran.
  result = preserveBaselineData(result, compact);

  // Union in any company the focused extraction found that synthesis dropped.
  result = mergeExtractedCompanies(result, extractedCompanies);

  // Remove any company the model invented (not in research or baseline).
  result = dropHallucinatedCompanies(result, compact, research);

  // Drop same-name contamination for common-name profiles with no anchor.
  result = gateSameNameExperience(result, compact, research);

  result = await enrichExperienceCompanyLinkedInIds(result, compact);

  // Final formatting pass so every text field is clean in the output.
  result = formatProfileOutput(result);

  mark('rescue + company ids');

  emitResult(result);

  console.log('\nDone.');
  console.log(`  Name: ${result.name || '-'}`);
  console.log(
    `  Role: ${result.current_role || '-'} @ ${result.current_company || '-'}`
  );
  console.log(`  Confidence: ${result.confidence_score}`);
  console.log(`  Missing fields: ${result.missing_fields.length}`);
  console.log(
    `  Calls: ${METRICS.linkedin_api_calls} LinkedIn, ` +
      `${METRICS.scrapingdog_ai_calls} AI Mode, ` +
      `${METRICS.perplexity_search_calls} Perplexity, ` +
      `${METRICS.openrouter_search_calls} OpenRouter search, ` +
      `${METRICS.openrouter_calls} OpenRouter total`
  );
  console.log(`  LinkedIn API failures: ${METRICS.linkedin_api_failures}`);
  console.log(`  AI Mode failures: ${METRICS.scrapingdog_ai_failures}`);
  console.log(`  OpenRouter cost: $${METRICS.openrouter_cost.toFixed(6)}`);
}

const RUN_STARTED_AT = Date.now();

function logElapsed() {
  console.log(`\nTotal time: ${((Date.now() - RUN_STARTED_AT) / 1000).toFixed(1)}s`);
}

main()
  .then(logElapsed)
  .catch((error) => {
    console.error(`\nError: ${error.message}`);
    if (error.response?.data) {
      console.error(JSON.stringify(error.response.data, null, 2));
    }
    logElapsed();
    process.exit(1);
});