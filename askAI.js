require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || 'sk-or-v1-key';
const SCRAPINGDOG_KEY = process.env.SCRAPINGDOG_KEY || 'key';
const OUTPUT_FILE = process.env.OUTPUT_FILE || 'askAI.json';


const SCENARIO = Number(process.env.SCENARIO || 2);
// fresh=true forces Scrapingdog to do a live LinkedIn scrape on every call,
// which is the slowest part of the profile fetch. Default to cached (fresh=false)
// for speed; set LINKEDIN_FRESH=true when you specifically need a live re-scrape.
const LINKEDIN_FRESH = process.env.LINKEDIN_FRESH === 'true';
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
// Research latency is dominated by AI Mode round-trips. They are independent, so
// the cheapest speedup is running more of them at once and not retrying dead
// calls. Concurrency 10 collapses the typical ~13 initial queries from ~4 waves
// into ~2; retries default to 0 so one hung call never serially blocks a worker.
const AI_MODE_CONCURRENCY = Number(process.env.AI_MODE_CONCURRENCY || 10);
const AI_MODE_RETRIES = Number(process.env.AI_MODE_RETRIES || 0);
const AI_MODE_RETRY_DELAY_MS = Number(
  process.env.AI_MODE_RETRY_DELAY_MS || 800
);
// AI Mode usually answers in 15-30s. Because every query runs concurrently in
// one wave, the research phase's wall-clock = the slowest single call, so this
// timeout is effectively the research-phase ceiling. 30s caps the tail; with
// retries off a timeout just drops that one query (fallback providers still fill
// in if it mattered). Raise it if you see useful queries getting cut.
const AI_MODE_TIMEOUT_MS = Number(process.env.AI_MODE_TIMEOUT_MS || 30000);
const AI_MODE_MAX_QUERY_CHARS = Number(
  process.env.AI_MODE_MAX_QUERY_CHARS || 900
);
const PERPLEXITY_BATCH_MODE = process.env.PERPLEXITY_BATCH_MODE !== 'false';
const PERPLEXITY_BATCH_SIZE = Number(
  process.env.PERPLEXITY_BATCH_SIZE || (RESEARCH_MODE === 'deep' ? 6 : 8)
);
const EXPERIENCE_FOLLOWUP_LIMIT = Number(
  process.env.EXPERIENCE_FOLLOWUP_LIMIT || (RESEARCH_MODE === 'deep' ? 5 : 3)
);
// The planner-driven second research pass (plan -> follow-up queries) is a fully
// sequential extra round-trip: it must wait for ALL first-pass research before
// it can run, then runs more searches. That is the single biggest serial cost in
// "standard" mode. Default it on only for "deep"; "standard" relies on the
// broader first pass + the conditional rescue. Re-enable with
// EXPERIENCE_FOLLOWUP_ENABLED=true. Sparse/private fallbacks always keep it
// (they have almost no baseline, so the second pass is where their data comes
// from) unless explicitly disabled.
const EXPERIENCE_FOLLOWUP_ENABLED =
  process.env.EXPERIENCE_FOLLOWUP_ENABLED === 'true' ||
  (process.env.EXPERIENCE_FOLLOWUP_ENABLED !== 'false' &&
    RESEARCH_MODE === 'deep');
const EXPERIENCE_RESCUE_ENABLED = process.env.EXPERIENCE_RESCUE_ENABLED !== 'false';
const RESCUE_MIN_EXPERIENCE_COUNT = Number(
  process.env.RESCUE_MIN_EXPERIENCE_COUNT || 5
);
const RESCUE_SEARCH_MODEL =
  process.env.RESCUE_SEARCH_MODEL || 'perplexity/sonar';
const RESCUE_CONTEXT_CHARS = Number(process.env.RESCUE_CONTEXT_CHARS || 3500);
const RESCUE_FIELD_CHARS = Number(process.env.RESCUE_FIELD_CHARS || 500);
// AI Mode + LLM is the least reliable ID source (it produced the wrong
// ProfitIndustry -> iccg-usa match). Off by default; deterministic SERP/website
// tiers run instead. Set COMPANY_ID_LOOKUP_ENABLED=true to re-enable.
const COMPANY_ID_LOOKUP_ENABLED =
  process.env.COMPANY_ID_LOOKUP_ENABLED === 'true';
const COMPANY_ID_LOOKUP_LIMIT = Number(process.env.COMPANY_ID_LOOKUP_LIMIT || 8);

// AI Mode is an internal product, so public contact research is enabled by
// default. Set INCLUDE_CONTACT=false when a product tier does not need it.
const INCLUDE_CONTACT = process.env.INCLUDE_CONTACT !== 'false';

// When the /profile API fails (or is intentionally bypassed), rebuild the
// identity anchor from the public Google SERP for the exact profile slug. This
// replaces the sparse fallback with a real baseline (name/role/company/location)
// so the normal experience-first research path runs instead of the crippled
// LinkedIn-anchor-only path.
const SERP_BASELINE_ENABLED = process.env.SERP_BASELINE_ENABLED !== 'false';
const SERP_COUNTRY = process.env.SERP_COUNTRY || 'us';
const SERP_RESULTS = Number(process.env.SERP_RESULTS || 10);
const SERP_TIMEOUT_MS = Number(process.env.SERP_TIMEOUT_MS || 15000);
// Resolve company LinkedIn slugs deterministically via SERP company dorks
// instead of (or before) the bundled AI Mode lookup.
const SERP_COMPANY_LOOKUP_ENABLED =
  process.env.SERP_COMPANY_LOOKUP_ENABLED !== 'false';
const SERP_COMPANY_CONCURRENCY = Number(
  process.env.SERP_COMPANY_CONCURRENCY || 8
);
// Indexing-independent tier: resolve a company's LinkedIn slug from its own
// website (the company links its own LinkedIn page). Catches companies whose
// LinkedIn page is not in Google's index.
const COMPANY_WEBSITE_LOOKUP_ENABLED =
  process.env.COMPANY_WEBSITE_LOOKUP_ENABLED !== 'false';
const COMPANY_WEBSITE_TIMEOUT_MS = Number(
  process.env.COMPANY_WEBSITE_TIMEOUT_MS || 5000
);

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
// Order = speed-first cascade. gemini-2.5-flash-lite is far faster than the 70B
// hermes model (synthesis was ~14s on hermes), and strict json_schema mode +
// post-synthesis validation make it safe to try first: if its output fails
// validation it automatically falls through to hermes (kept as the quality
// fallback). Override with SYNTHESIS_MODELS to put hermes first if you find the
// experience section is less complete.
const SYNTHESIS_MODELS = envList(
  'SYNTHESIS_MODELS',
  'google/gemini-2.5-flash-lite,nousresearch/hermes-4-70b,openai/gpt-4o-mini'
);

const PLANNER_MODELS = envList(
  'PLANNER_MODELS',
  'google/gemini-2.5-flash-lite,nousresearch/hermes-4-70b,openai/gpt-4o-mini'
);

const MAX_ACTIVITIES = Number(process.env.MAX_ACTIVITIES || 8);
const MAX_ACTIVITY_CHARS = Number(process.env.MAX_ACTIVITY_CHARS || 500);
const MAX_RESEARCH_CHARS = Number(process.env.MAX_RESEARCH_CHARS || 10000);
// Synthesis is a single LLM call whose latency scales with input size. The
// research blob is highly redundant across queries (and the model dedupes it
// anyway), so ~60k chars (~15k tokens) keeps the useful signal while roughly
// halving the synthesis prompt vs the old 120k. Raise it back if you see the
// model missing older roles that were present in the research.
const MAX_TOTAL_RESEARCH_CHARS = Number(
  process.env.MAX_TOTAL_RESEARCH_CHARS || 60000
);

const METRICS = {
  openrouter_calls: 0,
  openrouter_cost: 0,
  perplexity_search_calls: 0,
  openrouter_search_calls: 0,
  scrapingdog_ai_calls: 0,
  scrapingdog_ai_failures: 0,
  serp_calls: 0,
  serp_failures: 0,
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
  'https://www.linkedin.com/in/yuriburchenya/';

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
          company_linkedin_id: nullableString,
        },
        required: [
          'company',
          'title',
          'location',
          'start_date',
          'end_date',
          'description',
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

const BASELINE_ANCHOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: nullableString,
    headline: nullableString,
    current_role: nullableString,
    current_company: nullableString,
    location: nullableString,
    experience: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          company: nullableString,
          title: nullableString,
          start_date: nullableString,
          end_date: nullableString,
        },
        required: ['company', 'title', 'start_date', 'end_date'],
      },
    },
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
        required: ['institution', 'degree', 'field', 'start_year', 'end_year'],
      },
    },
  },
  required: [
    'name',
    'headline',
    'current_role',
    'current_company',
    'location',
    'experience',
    'education',
  ],
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

      return {
        company:
          item.company_name ||
          item.company ||
          item.companyName ||
          item.organization ||
          null,
        title: item.position || item.title || item.role || null,
        location: item.location || null,
        start_date:
          item.start_date || item.starts_at || item.startDate || null,
        end_date: item.end_date || item.ends_at || item.endDate || null,
        duration: item.duration || null,
        description: trimText(item.description || item.summary || null, 1000),
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
    company: item?.company || null,
    title: item?.title || null,
    location: item?.location || null,
    start_date: item?.start_date || null,
    end_date: item?.end_date || null,
    description: item?.description || null,
    company_linkedin_id:
      firstPresent(
        item?.company_linkedin_id,
        item?.company_id,
        item?.company_public_id
      ) || extractLinkedInCompanyId(companyUrl),
  };
}

function normalizeAndValidateProfileResult(result) {
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

  if (!result.experience.length) {
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

async function callStructuredAI(userPrompt) {
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
          max_tokens: 3500,
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
      return normalizeAndValidateProfileResult(JSON.parse(content));
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
  const profileId = resolveProfileId(profile);

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

// The full post-synthesis guard chain, applied identically after the first
// synthesis and after the rescue re-synthesis. Order matters: private-fallback
// stripping runs before the low-evidence baseline check.
function applyResultSanitizers(result, profile, research) {
  result = sanitizePrivateFallbackResult(result, profile, research);
  result = sanitizePrivateFallbackExperience(result, profile, research);
  result = sanitizeLowEvidenceBaselineResult(result, profile, research);
  return result;
}

function buildProfileNotFoundResult(profile) {
  const rawNameParts = String(profile.name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const profileId = resolveProfileId(profile);

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
        timeout: 90000,
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
  const profileId = resolveProfileId(profile);
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

async function fetchLinkedInProfile(linkedinUrl) {
  const profileId = getLinkedInProfileId(linkedinUrl);
  if (!profileId) throw new Error(`Invalid LinkedIn URL: ${linkedinUrl}`);

  METRICS.linkedin_api_calls += 1;
  const response = await axios.get(
    'https://api.scrapingdog.com/profile/',
    {
      params: {
        api_key: SCRAPINGDOG_KEY,
        type: 'profile',
        id: profileId,
        fresh: LINKEDIN_FRESH ? 'true' : 'false',
      },
      timeout: 30000,
    }
  );

  if (!response.data || typeof response.data !== 'object') {
    throw new Error('LinkedIn API returned an empty or invalid response');
  }

  return response.data;
}

function getLinkedInProfileId(linkedinUrl) {
  return linkedinUrl.split('/in/')[1]?.split(/[/?#]/)[0] || '';
}

// The profile slug, preferring an explicit identifier and falling back to the
// one parsed from the LinkedIn URL. Used wherever we anchor identity.
function resolveProfileId(profile) {
  return (
    profile.linkedin_public_identifier ||
    getLinkedInProfileId(profile.linkedin_url || '')
  );
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

async function serpSearch(query, results = SERP_RESULTS) {
  try {
    METRICS.serp_calls += 1;
    const response = await axios.get('https://api.scrapingdog.com/google', {
      params: {
        api_key: SCRAPINGDOG_KEY,
        query,
        results,
        country: SERP_COUNTRY,
      },
      timeout: SERP_TIMEOUT_MS,
    });
    const data = response.data || {};
    return Array.isArray(data.organic_results) ? data.organic_results : [];
  } catch (error) {
    METRICS.serp_failures += 1;
    console.warn(`  SERP search failed: ${error.message}`);
    return [];
  }
}

function nameFromSerpTitle(title) {
  // "Darshan Khandelwal - Co-Founder Scrapingdog.com - LinkedIn"
  const cleaned = String(title || '')
    .replace(/\s*[|\-–]\s*LinkedIn.*$/i, '')
    .trim();
  if (!cleaned) return { name: null, headline: null };
  const parts = cleaned.split(/\s+[-–|]\s+/);
  return {
    name: (parts[0] || '').trim() || null,
    headline: parts.slice(1).join(' - ').trim() || null,
  };
}

function serpLinkMatchesSlug(item, slug) {
  const link = normalizedEvidenceText(item.link || item.url || '');
  const target = `linkedin.com/in/${normalizedEvidenceText(slug)}`;
  return !!link && link.includes(target);
}

// A SERP result is tied to this exact identity if its link is the profile slug
// page, or its title/url/snippet mentions the exact slug or profile URL. This is
// what keeps the richer multi-result baseline free of same-name contamination.
function serpResultIsIdentityAnchored(item, slug, linkedinUrl) {
  if (serpLinkMatchesSlug(item, slug)) return true;

  const hay = normalizedEvidenceText(
    `${item.title || ''} ${item.link || item.url || ''} ${item.snippet || ''}`
  );
  const slugKey = normalizedEvidenceText(slug);
  const urlKey = normalizedEvidenceText(linkedinUrl).replace(/\/+$/g, '');

  return (
    (!!slugKey && hay.includes(`/in/${slugKey}`)) ||
    (!!urlKey && hay.includes(urlKey))
  );
}

function serpResultEvidenceBlock(item, index) {
  return [
    `[result ${index + 1}]`,
    `title: ${item.title || ''}`,
    `url: ${item.link || item.url || ''}`,
    `snippet: ${trimText(item.snippet || '', 600)}`,
  ].join('\n');
}

// Rebuilds the identity anchor that /profile used to provide, using only the
// public Google SERP for the exact profile slug. Two identity-anchored angles
// run together: the profile page itself (site:linkedin.com/in/<slug> pins it to
// rank 1, an identity lock with no same-name risk) AND pages that quote the
// exact profile URL (posts, aggregators, bios). Aggregating snippets across the
// anchored results gives the extractor far more context than a single result, so
// the recovered baseline carries real current-role/company/location/older-role
// data instead of just a name -> this is the main "more data when the Profile
// API fails" path. Returns a NON-sparse baseline so the normal
// experience-first research path runs downstream.
async function reconstructBaselineFromPublic(linkedinUrl) {
  if (!SERP_BASELINE_ENABLED) return null;

  const slug = getLinkedInProfileId(linkedinUrl);
  if (!slug) return null;

  const cleanUrl = linkedinUrl.replace(/\/?$/, '/');
  const [slugResults, urlResults] = await Promise.all([
    serpSearch(`site:linkedin.com/in/${slug}`),
    serpSearch(`"${cleanUrl}"`),
  ]);

  const organic = [...slugResults, ...urlResults];
  if (!organic.length) {
    console.warn('  SERP baseline: no indexed result for this profile slug.');
    return null;
  }

  const anchoredResults = dedupeBy(
    organic.filter((item) =>
      serpResultIsIdentityAnchored(item, slug, linkedinUrl)
    ),
    (item) => normalizedEvidenceText(item.link || item.url || '')
  );

  const lockedResult = anchoredResults.find((item) =>
    serpLinkMatchesSlug(item, slug)
  );
  const identityLocked = !!lockedResult;

  // Locked LinkedIn page first, then the rest of the anchored context. If
  // nothing is anchored, fall back to the old single-top-result behavior.
  const contextResults = (
    anchoredResults.length
      ? dedupeBy(
          [lockedResult, ...anchoredResults].filter(Boolean),
          (item) => normalizedEvidenceText(item.link || item.url || '')
        )
      : [organic[0]]
  ).slice(0, 6);

  const anchor = lockedResult || contextResults[0] || organic[0];
  if (!anchor || !(anchor.title || anchor.snippet)) {
    console.warn('  SERP baseline: top result had no title/snippet to parse.');
    return null;
  }

  const heuristic = nameFromSerpTitle(anchor.title);

  const evidenceBlock = contextResults
    .map((item, index) => serpResultEvidenceBlock(item, index))
    .join('\n\n');

  let extracted = null;
  try {
    extracted = await callJsonAI({
      label: 'serp_baseline_anchor',
      systemPrompt:
        'You extract a structured professional baseline from Google search ' +
        'results for one exact LinkedIn profile. Use only facts present in the ' +
        'supplied result titles and snippets. Merge facts across results when ' +
        'they clearly describe the same person. Never invent. Use null/[] when ' +
        'absent.',
      userPrompt: `LinkedIn URL: ${linkedinUrl}
Profile slug: ${slug}

Search results (all tied to this exact profile slug/URL):
${evidenceBlock}

Extract name, headline, current_role, current_company, location, any visible
experience rows (company/title/dates), and education. Merge consistent facts
across the results. Do not use outside knowledge. Do not include same-name
people.`,
      schema: BASELINE_ANCHOR_SCHEMA,
      maxTokens: 1100,
      models: PLANNER_MODELS,
    });
  } catch (error) {
    console.warn(
      `  SERP baseline extraction failed, using title heuristic: ${error.message}`
    );
  }

  const seedExperience = Array.isArray(extracted?.experience)
    ? extracted.experience
        .filter((row) => row && (row.company || row.title))
        .map((row) => ({
          company: row.company || null,
          title: row.title || null,
          location: null,
          start_date: row.start_date || null,
          end_date: row.end_date || null,
          duration: null,
          description: null,
          company_linkedin_id: null,
        }))
    : [];

  const name =
    extracted?.name || heuristic.name || nameFromLinkedInProfileId(slug);
  const headline = extracted?.headline || heuristic.headline || null;
  const currentCompany =
    extracted?.current_company || seedExperience[0]?.company || null;
  const currentRole =
    extracted?.current_role || seedExperience[0]?.title || null;

  return {
    profile_source: 'serp_reconstructed',
    serp_identity_locked: identityLocked,
    fallback_reason: 'linkedin_profile_api_unavailable_used_serp_baseline',
    name,
    headline,
    current_company: currentCompany,
    current_role: currentRole,
    location: extracted?.location || null,
    linkedin_url: linkedinUrl,
    linkedin_public_identifier: slug,
    website: null,
    about: null,
    followers: null,
    connections: null,
    is_open_to_work: false,
    is_hiring: false,
    email: null,
    phone: null,
    social_links: [],
    experience: seedExperience,
    education: Array.isArray(extracted?.education) ? extracted.education : [],
    skills: [],
    languages: [],
    certifications: [],
    activities: [],
    anchor_reference: {
      title: anchor.title || null,
      url: anchor.link || anchor.url || null,
      snippet: trimText(anchor.snippet || '', 500),
    },
  };
}

async function fetchLinkedInProfileOrFallback(linkedinUrl) {
  let profileError;

  try {
    return compactProfile(await fetchLinkedInProfile(linkedinUrl), linkedinUrl);
  } catch (error) {
    METRICS.linkedin_api_failures += 1;
    profileError = error;
    console.warn(
      `  LinkedIn profile API failed (${error.message}). Trying SERP baseline reconstruction...`
    );
  }

  if (SERP_BASELINE_ENABLED) {
    const reconstructed = await reconstructBaselineFromPublic(linkedinUrl);
    if (reconstructed) {
      console.log(
        `  SERP baseline recovered: ${reconstructed.name || '-'} | ` +
          `${reconstructed.current_role || '-'} @ ${reconstructed.current_company || '-'} ` +
          `(identity_locked=${reconstructed.serp_identity_locked})`
      );
      return reconstructed;
    }
  }

  if (!LINKEDIN_PROFILE_FALLBACK) {
    throw profileError;
  }

  console.warn(
    '  No SERP baseline available. Continuing with sparse AI Mode fallback.'
  );
  return buildLinkedInFallbackProfile(linkedinUrl, profileError.message);
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
    .replace(/\b(pvt|private|limited|ltd|inc|llc|llp|corp|corporation|co)\b/g, '')
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

function companyEvidenceMatchesName(company, id, title = '') {
  const companyFlat = normalizedCompanyKey(company).replace(/ /g, '');
  if (!companyFlat) return false;

  const slugFlat = normalizedText(id).replace(/[^a-z0-9]/g, '');
  const titleFlat = normalizedCompanyKey(
    String(title).replace(/\s*[|\-–]\s*linkedin.*$/i, '')
  ).replace(/ /g, '');

  if (!slugFlat && !titleFlat) return false;

  // Strongest signal: the LinkedIn page's own name equals the company name.
  if (titleFlat && titleFlat === companyFlat) return true;
  // Exact slug match.
  if (slugFlat && slugFlat === companyFlat) return true;

  // Allow only a company name plus a harmless domain/corp suffix (g2 -> g2dotcom),
  // never company + a real extra word (apple -> applesauce-farms is rejected).
  const SUFFIX = /^(inc|llc|co|com|dotcom|io|ai|hq)$/;
  if (slugFlat && slugFlat.startsWith(companyFlat)) {
    if (SUFFIX.test(slugFlat.slice(companyFlat.length))) return true;
  }
  if (slugFlat && companyFlat.startsWith(slugFlat)) {
    if (SUFFIX.test(companyFlat.slice(slugFlat.length))) return true;
  }

  return false;
}

function serpCompanyMatch(item, company) {
  const link = normalizeLinkedInCompanyUrl(item.link || item.url || '');
  if (!link || !/linkedin\.com\/(?:company|school)\//i.test(link)) return null;

  const id = extractLinkedInCompanyId(link);
  if (!id) return null;

  // The site dork already constrains Google to pages naming the company; this
  // name check is a guard against accepting a wrong-company page.
  if (!companyEvidenceMatchesName(company, id, item.title)) return null;

  return {
    company,
    linkedin_url: link,
    linkedin_id: id,
    confidence: 'high',
    source_url: link,
  };
}

async function resolveCompanyLinkedInIdViaSerp(company) {
  // Run the company and school dorks together, but keep company-before-school
  // priority when picking the match (a real org should win over a same-named
  // school page).
  const [companyResults, schoolResults] = await Promise.all([
    serpSearch(`site:linkedin.com/company ${JSON.stringify(company)}`, 5),
    serpSearch(`site:linkedin.com/school ${JSON.stringify(company)}`, 5),
  ]);

  for (const organic of [companyResults, schoolResults]) {
    for (const item of organic) {
      const match = serpCompanyMatch(item, company);
      if (match) return match;
    }
  }

  return null;
}

async function resolveCompanyLinkedInIdsViaSerp(targets) {
  const byCompany = new Map();
  if (!SERP_COMPANY_LOOKUP_ENABLED || !targets.length) return byCompany;

  const matches = await mapWithConcurrency(
    targets,
    SERP_COMPANY_CONCURRENCY,
    (target) => resolveCompanyLinkedInIdViaSerp(target.company)
  );

  for (const match of matches) {
    if (!match) continue;
    const key = normalizedCompanyKey(match.company);
    if (key) byCompany.set(key, match);
  }

  return byCompany;
}

// Indexing-independent resolver: find the company's homepage, then read its
// LinkedIn company link straight from the page. Works even when the LinkedIn
// page itself is not indexed by Google, as long as the company has a live site.
function isOfficialSiteCandidate(link, company) {
  if (!/^https?:\/\//i.test(link)) return false;
  if (
    /(linkedin|facebook|twitter|x\.com|instagram|youtube|tiktok|crunchbase|wikipedia|bloomberg|glassdoor|indeed|pitchbook|zoominfo|medium|github)\./i.test(
      link
    )
  ) {
    return false;
  }
  let url;
  try {
    url = new URL(link);
  } catch {
    return false;
  }

  const host = url.hostname || '';
  const hostKey = normalizedText(host).replace(/[^a-z0-9]/g, '');
  const pathDepth = url.pathname
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean).length;
  const tokens = normalizedCompanyKey(company)
    .split(' ')
    .filter((t) => t.length > 2)
    .map((t) => t.replace(/[^a-z0-9]/g, ''));

  const companyFlat = normalizedCompanyKey(company).replace(/ /g, '');
  const hostMatchesCompany =
    (companyFlat && hostKey.includes(companyFlat)) ||
    tokens.some((t) => t && hostKey.includes(t));

  if (!hostMatchesCompany) return false;

  // Prefer root/homepage-like results. This prevents third-party article URLs
  // from being treated as official company homepages.
  return pathDepth <= 1;
}

async function findCompanyHomepage(company, knownUrl) {
  if (
    knownUrl &&
    /^https?:\/\//i.test(knownUrl) &&
    !/linkedin\.com/i.test(knownUrl)
  ) {
    return knownUrl;
  }

  const organic = await serpSearch(JSON.stringify(company), 5);
  const official = organic.find((item) =>
    isOfficialSiteCandidate(item.link || item.url || '', company)
  );
  return official?.link || official?.url || null;
}

async function resolveCompanyLinkedInIdViaWebsite(company, knownUrl) {
  if (!COMPANY_WEBSITE_LOOKUP_ENABLED) return null;

  const homepage = await findCompanyHomepage(company, knownUrl);
  if (!homepage) return null;

  let html = '';
  try {
    const response = await axios.get(homepage, {
      timeout: COMPANY_WEBSITE_TIMEOUT_MS,
      maxContentLength: 4_000_000,
      maxRedirects: 4,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProfileEnricher/1.0)' },
    });
    html =
      typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data);
  } catch (error) {
    return null;
  }

  const match = html.match(
    /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/[^"'\s<>?#]+/i
  );
  if (!match) return null;

  const link = normalizeLinkedInCompanyUrl(match[0]);
  const id = extractLinkedInCompanyId(link);
  if (!id) return null;

  // The company's own site is a good signal, but not enough. Some pages mention
  // a target company inside unrelated articles and link their own LinkedIn page
  // (example: ProfitIndustry.com mentioned on AZ Big Media -> az-big-media).
  // Keep only IDs whose slug/name matches the target company.
  if (!companyEvidenceMatchesName(company, id, '')) {
    console.warn(`  Dropping website company mismatch: ${company} -> ${id}`);
    return null;
  }

  return {
    company,
    linkedin_url: link,
    linkedin_id: id,
    confidence: 'high',
    source_url: homepage,
  };
}

async function resolveCompanyLinkedInIdsViaWebsite(targets) {
  const byCompany = new Map();
  if (!COMPANY_WEBSITE_LOOKUP_ENABLED || !targets.length) return byCompany;

  const matches = await mapWithConcurrency(
    targets,
    SERP_COMPANY_CONCURRENCY,
    (target) => resolveCompanyLinkedInIdViaWebsite(target.company, null)
  );

  for (const match of matches) {
    if (!match) continue;
    const key = normalizedCompanyKey(match.company);
    if (key) byCompany.set(key, match);
  }

  return byCompany;
}

// Remove any company LinkedIn id/URL the synthesis model invented (e.g.
// ProfitIndustry -> az-big-media). After this, the only ids that survive are
// ones whose slug actually matches the company name; everything else is nulled
// and left for the deterministic resolver to fill (or stay null).
function stripUnverifiedCompanyIds(result) {
  let stripped = 0;

  const experience = (result.experience || []).map((raw) => {
    const item = cleanExperienceEntry(raw);
    const candidateId = item.company_linkedin_id;

    if (
      candidateId &&
      !companyEvidenceMatchesName(item.company, candidateId, '')
    ) {
      stripped += 1;
      return {
        ...item,
        company_linkedin_id: null,
      };
    }

    return item;
  });

  if (stripped) {
    console.log(`  Stripped ${stripped} unverified company LinkedIn id(s).`);
  }

  return { ...result, experience };
}

function normalizeExperienceForOutput(result) {
  return {
    ...result,
    experience: (result.experience || []).map((item) => cleanExperienceEntry(item)),
  };
}

// Deterministically resolve LinkedIn IDs for the companies already in the
// baseline profile. These are known before synthesis, so main() runs this
// concurrently with collectResearch and feeds the result into
// enrichExperienceCompanyLinkedInIds as a seed -> the company-resolution tail
// after synthesis only has to handle whatever NEW companies research added.
// Uses the deterministic SERP + website tiers only (no AI Mode), matching the
// post-synthesis path's trusted tiers.
async function prefetchBaselineCompanyIds(profile) {
  if (!SERP_COMPANY_LOOKUP_ENABLED && !COMPANY_WEBSITE_LOOKUP_ENABLED) {
    return new Map();
  }

  const targets = companyLookupTargets(profile);
  if (!targets.length) return new Map();

  const byCompany = await resolveCompanyLinkedInIdsViaSerp(targets);

  if (COMPANY_WEBSITE_LOOKUP_ENABLED) {
    const unresolved = targets.filter(
      (item) => !byCompany.has(normalizedCompanyKey(item.company))
    );
    if (unresolved.length) {
      const websiteMatches = await resolveCompanyLinkedInIdsViaWebsite(
        unresolved
      );
      for (const [key, match] of websiteMatches) {
        if (!byCompany.has(key)) byCompany.set(key, match);
      }
    }
  }

  if (byCompany.size) {
    console.log(
      `  Prefetched ${byCompany.size} baseline company LinkedIn slug(s) during research.`
    );
  }

  return byCompany;
}

async function enrichExperienceCompanyLinkedInIds(
  result,
  profile,
  seedCompanyIds = null
) {
  // Always run first: never trust an LLM-produced company id.
  result = stripUnverifiedCompanyIds(result);

  if (
    !COMPANY_ID_LOOKUP_ENABLED &&
    !SERP_COMPANY_LOOKUP_ENABLED &&
    !COMPANY_WEBSITE_LOOKUP_ENABLED
  ) {
    return normalizeExperienceForOutput(result);
  }

  const targets = companyLookupTargets(result);
  if (!targets.length) return normalizeExperienceForOutput(result);

  // Seed with IDs resolved in parallel with research (baseline companies), then
  // only resolve the companies that are still missing.
  const byCompany = new Map();
  if (seedCompanyIds) {
    for (const [key, match] of seedCompanyIds) byCompany.set(key, match);
  }
  const prefetchedHits = targets.filter((item) =>
    byCompany.has(normalizedCompanyKey(item.company))
  ).length;

  const targetsToResolve = targets.filter(
    (item) => !byCompany.has(normalizedCompanyKey(item.company))
  );

  console.log(
    `  Resolving ${targetsToResolve.length} missing company LinkedIn IDs ` +
      `(${prefetchedHits} prefetched during research)...`
  );

  // Primary: deterministic per-company SERP resolution.
  const serpResolved = await resolveCompanyLinkedInIdsViaSerp(targetsToResolve);
  let serpAdded = 0;
  for (const [key, match] of serpResolved) {
    if (!byCompany.has(key)) {
      byCompany.set(key, match);
      serpAdded += 1;
    }
  }
  if (serpAdded) {
    console.log(`  SERP resolved ${serpAdded} company LinkedIn slugs.`);
  }

  const unresolvedAfterSerp = targets.filter(
    (item) => !byCompany.has(normalizedCompanyKey(item.company))
  );

  // Tier 2 (indexing-independent): read the slug from the company's own site.
  if (COMPANY_WEBSITE_LOOKUP_ENABLED && unresolvedAfterSerp.length) {
    const websiteMatches = await resolveCompanyLinkedInIdsViaWebsite(
      unresolvedAfterSerp
    );
    let added = 0;
    for (const [key, match] of websiteMatches) {
      if (!byCompany.has(key)) {
        byCompany.set(key, match);
        added += 1;
      }
    }
    if (added) {
      console.log(`  Website tier resolved ${added} company LinkedIn slugs.`);
    }
  }

  // Tier 3 (last resort): AI Mode + LLM, only for what is still missing, and
  // every returned record is name-verified so a wrong-company slug is dropped.
  const unresolved = targets.filter(
    (item) => !byCompany.has(normalizedCompanyKey(item.company))
  );

  if (COMPANY_ID_LOOKUP_ENABLED && unresolved.length) {
    const query = buildCompanyIdLookupQuery(unresolved, result, profile);
    const aiModeResult = await scrapingdogAI(query);

    if (isUsefulResearchResult(aiModeResult)) {
      try {
        const lookup = await callJsonAI({
          label: 'company_linkedin_id_lookup',
          systemPrompt: `
You map company names to official LinkedIn company/school URLs from supplied
search evidence. Use only the supplied evidence. Do not infer IDs from memory.
Return not_found when the evidence does not contain an official LinkedIn
company/school URL.
`.trim(),
          userPrompt: `
Target companies:
${JSON.stringify(unresolved.map((item) => item.company), null, 2)}

Search evidence:
${trimText(aiModeResult, 20000)}
`.trim(),
          schema: COMPANY_ID_LOOKUP_SCHEMA,
          maxTokens: 1800,
          models: PLANNER_MODELS,
        });

        for (const item of lookup.companies || []) {
          const cleaned = cleanCompanyLookupRecord(item);
          if (!cleaned) continue;
          // Verify the returned slug against the claimed company name. No page
          // title here, so this relies on the slug (drops ProfitIndustry -> iccg-usa).
          if (
            !companyEvidenceMatchesName(cleaned.company, cleaned.linkedin_id, '')
          ) {
            console.warn(
              `  Dropping unverified company match: ${cleaned.company} -> ${cleaned.linkedin_id}`
            );
            continue;
          }
          const key = normalizedCompanyKey(cleaned.company);
          if (key && !byCompany.has(key)) byCompany.set(key, cleaned);
        }
      } catch (error) {
        console.warn(`  Company LinkedIn ID parser failed: ${error.message}`);
      }
    } else {
      console.warn('  AI Mode company fallback returned no usable evidence.');
    }
  }

  if (!byCompany.size) return normalizeExperienceForOutput(result);

  const experience = (result.experience || []).map((item) => {
    const cleaned = cleanExperienceEntry(item);
    if (cleaned.company_linkedin_id) return cleaned;

    const match = byCompany.get(normalizedCompanyKey(cleaned.company));
    if (!match) return cleaned;

    return {
      ...cleaned,
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

  // Final safety pass: deterministic resolvers can still pick a wrong linked
  // page from noisy SERP/website evidence. Never let a mismatch reach output.
  return normalizeExperienceForOutput(stripUnverifiedCompanyIds({ ...result, experience }));
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
  const profileId = resolveProfileId(profile);
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

async function collectResearch(scenario, profile) {
  if (RESEARCH_MODE === 'off') return '';

  const queries = selectInitialResearchQueries(scenario, profile);

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

  const results = await runResearchQueries(queries, 0, profile);

  const combined = results
    .filter(({ result }) => result)
    .map(({ label, result }) => `[${label}]\n${result}`)
    .join('\n\n');

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

  // Fast path: when the Profile API actually returned a full profile, the first
  // pass already covers the experience section well. The planner second pass is
  // a sequential extra round-trip, so skip it here unless explicitly enabled
  // (or RESEARCH_MODE=deep). Recovered profiles (serp_reconstructed) and sparse
  // private fallbacks intentionally fall through: the second pass is where most
  // of their data comes from, which is exactly the failed-/profile-API case we
  // want to enrich harder.
  if (profile.profile_source === 'linkedin_api' && !EXPERIENCE_FOLLOWUP_ENABLED) {
    console.log(
      '  Complete API profile: skipping planner follow-up pass (fast path). ' +
        'Set EXPERIENCE_FOLLOWUP_ENABLED=true or RESEARCH_MODE=deep to re-enable.'
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

  return `
Create the final professional profile from the compact baseline and optional
live research below.

Scenario:
${scenario}

Required data_source:
${sourceLabel}

Baseline profile:
${JSON.stringify(profile)}

Live research:
${research || 'No live research was performed.'}

Instructions:
- EXPERIENCE IS THE MOST IMPORTANT FIELD. Spend most of your effort there.
- The final experience array should be as complete as the evidence allows,
  including older roles and grouped sub-roles hidden from public LinkedIn.
- For each experience entry, use the most specific title, company, location,
  date range, duration, company_linkedin_id, and description supported by
  baseline or research.
- When only a company/title is verified but dates are not, include the role with
  null dates instead of dropping it.
- Never include an experience entry with a null title. A company-only hint is
  not an experience record.
- Never add duplicate company-only entries when a detailed role already exists
  for that company.
- Never write descriptions with phrases like "likely involved", "probably",
  or "may have". If responsibilities are not sourced, set description to null.
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
- Do not include company_url in experience rows.
- Set company_linkedin_id to null during synthesis. Verified company LinkedIn
  IDs are resolved deterministically after synthesis.
- Skills may be conservatively inferred from verified roles and activities.
- Do not invent contact information, dates, URLs, education, or employers.
- If contact research was disabled, keep email and phone null unless they were
  already present in the baseline.
- Keep arrays deduplicated and ordered by relevance or recency.
- Populate missing_fields after all other fields are complete.
`.trim();
}

// Lightweight phase stopwatch: each call prints the time since the previous
// call, so the console shows exactly where the run spends its seconds.
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

  mark('profile fetch / baseline');

  // Resolve baseline company LinkedIn IDs concurrently with research so that
  // work is off the post-synthesis critical path.
  const [research, baselineCompanyIds] = await Promise.all([
    collectResearch(SCENARIO, compact),
    prefetchBaselineCompanyIds(compact),
  ]);

  mark('research + company prefetch');

  if (
    isSparseLinkedInFallbackProfile(compact) &&
    !hasAcceptedPrivateProfileResearch(research, compact)
  ) {
    const result = buildProfileNotFoundResult(compact);
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));

    console.log(
      '  Identity verification failed. Returning profile_not_found before synthesis.'
    );
    console.log(`\nDone. Result saved to ${OUTPUT_FILE}`);
    console.log(`  Status: ${result.status}`);
    console.log(`  Error: ${result.error}`);
    console.log(`  Name: ${result.name || '-'}`);
    console.log(
      `  Calls: ${METRICS.linkedin_api_calls} LinkedIn, ` +
        `${METRICS.scrapingdog_ai_calls} AI Mode, ` +
        `${METRICS.serp_calls} SERP, ` +
        `${METRICS.perplexity_search_calls} Perplexity, ` +
        `${METRICS.openrouter_search_calls} OpenRouter search, ` +
        `${METRICS.openrouter_calls} OpenRouter total`
    );
    console.log(`  LinkedIn API failures: ${METRICS.linkedin_api_failures}`);
    console.log(`  AI Mode failures: ${METRICS.scrapingdog_ai_failures}`);
    console.log(`  OpenRouter cost: $${METRICS.openrouter_cost.toFixed(6)}`);
    return;
  }

  let prompt = buildSynthesisPrompt(SCENARIO, compact, research);
  let result = await callStructuredAI(prompt);
  result = applyResultSanitizers(result, compact, research);

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
      result = applyResultSanitizers(result, compact, rescuedResearch);
    }
    mark('experience rescue');
  }

  result = await enrichExperienceCompanyLinkedInIds(
    result,
    compact,
    baselineCompanyIds
  );

  mark('company id resolution');

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));

  console.log(`\nDone. Result saved to ${OUTPUT_FILE}`);
  console.log(`  Name: ${result.name || '-'}`);
  console.log(
    `  Role: ${result.current_role || '-'} @ ${result.current_company || '-'}`
  );
  console.log(`  Confidence: ${result.confidence_score}`);
  console.log(`  Missing fields: ${result.missing_fields.length}`);
  console.log(
    `  Calls: ${METRICS.linkedin_api_calls} LinkedIn, ` +
      `${METRICS.scrapingdog_ai_calls} AI Mode, ` +
        `${METRICS.serp_calls} SERP, ` +
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
  const seconds = (Date.now() - RUN_STARTED_AT) / 1000;
  console.log(`\nTotal time: ${seconds.toFixed(1)}s`);
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