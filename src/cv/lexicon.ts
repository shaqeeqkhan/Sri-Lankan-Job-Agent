/**
 * Word lists for `slj factcheck`. All lower case. Multi-word entries are matched as whole phrases
 * after normalisation (see `norm` in factcheck.ts), so "power bi" also matches "Power-BI".
 */

/** Tools and technologies. Any of these in cv.md must also be in resume.md or facts.yml. */
export const TOOLS = [
  // office and finance
  'excel', 'microsoft excel', 'word', 'powerpoint', 'outlook', 'microsoft office', 'office 365', 'google sheets',
  'google workspace', 'tally', 'quickbooks', 'sage', 'xero', 'peachtree', 'sap', 'sap fico', 'sap mm', 'oracle',
  'oracle financials', 'netsuite', 'dynamics', 'navision', 'zoho', 'pastel', 'ifs', 'odoo',
  // data
  'sql', 'mysql', 'postgresql', 'postgres', 'sql server', 'mssql', 'sqlite', 'mongodb', 'redis', 'snowflake',
  'bigquery', 'redshift', 'databricks', 'spark', 'pyspark', 'hadoop', 'airflow', 'dbt', 'ssis', 'ssrs', 'ssas',
  'power bi', 'tableau', 'looker', 'qlik', 'qlikview', 'qlik sense', 'metabase', 'superset', 'spss', 'stata', 'sas',
  'matlab', 'minitab', 'pandas', 'numpy', 'scikit learn', 'sklearn', 'tensorflow', 'pytorch', 'keras', 'jupyter',
  'r studio', 'rstudio', 'google analytics', 'ga4', 'data studio', 'looker studio', 'alteryx', 'knime', 'dax',
  'power query', 'vba', 'macros',
  // languages and frameworks
  'python', 'java', 'javascript', 'typescript', 'php', 'ruby', 'golang', 'kotlin', 'swift', 'scala', 'perl',
  'c++', 'c#', 'dotnet', '.net', 'aspnet', 'asp.net', 'html', 'css', 'sass', 'react', 'react native', 'angular',
  'vue', 'vuejs', 'nextjs', 'next.js', 'nodejs', 'node.js', 'node', 'express', 'django', 'flask', 'fastapi',
  'spring', 'spring boot', 'laravel', 'rails', 'flutter', 'dart', 'jquery', 'bootstrap', 'tailwind', 'graphql',
  'rest api', 'rest apis', 'soap', 'kafka', 'rabbitmq', 'elasticsearch', 'hibernate', 'junit', 'selenium',
  'cypress', 'jest', 'playwright', 'postman', 'wordpress', 'shopify', 'magento', 'salesforce', 'hubspot',
  // infrastructure
  'aws', 'azure', 'gcp', 'google cloud', 'docker', 'kubernetes', 'terraform', 'ansible', 'jenkins', 'github actions',
  'gitlab', 'git', 'github', 'bitbucket', 'jira', 'confluence', 'linux', 'ubuntu', 'windows server', 'active directory',
  'vmware', 'cisco', 'ccna', 'ccnp', 'nginx', 'apache', 'ec2', 's3', 'lambda', 'firebase', 'heroku', 'vercel',
  // design and marketing
  'photoshop', 'illustrator', 'indesign', 'premiere pro', 'after effects', 'lightroom', 'canva', 'figma', 'sketch',
  'adobe xd', 'coreldraw', 'autocad', 'revit', 'solidworks', 'sketchup', 'meta ads', 'facebook ads', 'google ads',
  'mailchimp', 'semrush', 'ahrefs', 'hootsuite', 'seo', 'sem',
] as const;

/** Qualifications, professional bodies and institutions common in Sri Lanka. */
export const QUALIFICATIONS = [
  'cima', 'acca', 'aat', 'ca sri lanka', 'chartered accountant', 'cpa', 'cfa', 'icasl', 'bcs', 'nvq',
  'nvq level 3', 'nvq level 4', 'nvq level 5', 'hnd', 'higher national diploma', 'pmp', 'prince2', 'itil', 'scrum master',
  'csm', 'cissp', 'ceh', 'comptia', 'ielts', 'toefl', 'pte', 'slim', 'cim', 'mba', 'msc', 'bsc', 'bcom', 'bba',
  'bachelor of science', 'bachelor of commerce', 'bachelor of arts', 'bachelor of business administration',
  'master of science', 'master of business administration', 'diploma', 'advanced diploma', 'phd', 'llb', 'attorney at law',
  'sliit', 'nsbm', 'iit', 'apiit', 'nibm', 'esoft', 'icbt', 'kdu', 'ousl', 'university of colombo',
  'university of moratuwa', 'university of peradeniya', 'university of kelaniya', 'university of sri jayewardenepura',
  'university of ruhuna', 'university of jaffna', 'open university',
] as const;

/** Function words: ignored when comparing phrases. */
export const STOP = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'for', 'in', 'at', 'on', 'to', 'with', 'by', 'from', 'as', 'via', 'into',
  'over', 'under', 'per', 'is', 'are', 'was', 'were', 'be', 'been', 'my', 'our', 'their', 'his', 'her', 'its',
  'this', 'that', 'these', 'those', 'than', 'then', 'also', 'both', 'all', 'each', 'any', 'such', 'other',
]);

/**
 * Words that are not entities even when capitalised: section names, field labels, honorifics,
 * months. A capitalised run made only of these is not a claim. Inside a run with other words they
 * still count (so "Sales Executive" must be in the corpus as a phrase).
 */
export const COMMON = new Set([
  'summary', 'profile', 'professional', 'objective', 'career', 'experience', 'experiences', 'work', 'employment',
  'history', 'education', 'educational', 'qualifications', 'qualification', 'academic', 'skills', 'skill', 'technical',
  'soft', 'key', 'core', 'competencies', 'achievements', 'achievement', 'responsibilities', 'duties', 'projects',
  'project', 'personal', 'details', 'detail', 'information', 'references', 'reference', 'referees', 'referee',
  'declaration', 'languages', 'language', 'interests', 'hobbies', 'activities', 'extracurricular', 'extra',
  'curricular', 'certifications', 'certification', 'certificates', 'awards', 'publications', 'highlights', 'contact',
  'name', 'full', 'address', 'email', 'mail', 'phone', 'mobile', 'telephone', 'tel', 'date', 'birth', 'dob',
  'nationality', 'gender', 'sex', 'civil', 'marital', 'status', 'religion', 'nic', 'number', 'no', 'age', 'male',
  'female', 'married', 'single', 'unmarried', 'sri', 'lanka', 'lankan', 'present', 'current', 'currently', 'now',
  'level', 'results', 'result', 'subject', 'subjects', 'grade', 'grades', 'year', 'years', 'index', 'stream',
  'attempt', 'team', 'department', 'division', 'unit', 'office', 'branch', 'head', 'customer', 'customers', 'client',
  'clients', 'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'rev', 'hon', 'eng', 'cv', 'resume', 'curriculum', 'vitae',
  'signature', 'i', 'hereby', 'declare', 'certify', 'true', 'correct', 'best', 'knowledge', 'linkedin', 'github',
  'portfolio', 'website', 'web', 'tools', 'tool', 'software', 'other', 'others', 'relevant', 'selected', 'additional',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november',
  'december', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'monday',
  'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'gce', 'ol', 'al', 'o', 'l', 'ordinary',
  'advanced', 'page', 'role', 'position', 'applied', 'course', 'courses', 'coursework', 'module', 'modules',
  'volunteer', 'volunteering', 'leadership', 'membership', 'memberships', 'member', 'internship',
]);

/** Acronyms that are labels, not claims. */
export const ALLOWED_ACRONYMS = new Set(['cv', 'nic', 'gce', 'ol', 'al', 'lkr', 'rs', 'usd', 'sl', 'dob', 'no', 'i', 'ii', 'iii', 'iv', 'v']);

/** Verbs that start CV bullets and do not end in -ed/-ing. Lower case. */
export const VERBS = new Set([
  'built', 'led', 'ran', 'won', 'made', 'wrote', 'drove', 'grew', 'cut', 'set', 'taught', 'oversaw', 'began', 'kept',
  'sold', 'brought', 'took', 'gave', 'found', 'held', 'met', 'spoke', 'chose', 'became', 'did', 'had', 'got', 'put',
  'won', 'lead', 'build', 'manage', 'develop', 'create', 'design', 'prepare', 'maintain', 'handle', 'support',
  'assist', 'coordinate', 'deliver', 'own', 'run', 'drive', 'write', 'analyse', 'analyze', 'reconcile', 'review',
  'train', 'mentor', 'automate', 'improve', 'reduce', 'increase', 'ship', 'migrate', 'deploy', 'test', 'plan',
  'organise', 'organize', 'serve', 'teach', 'oversee', 'track', 'monitor', 'report', 'process', 'record',
  'conduct', 'liaise', 'ensure', 'provide', 'perform', 'implement', 'launch', 'grow', 'sell', 'negotiate',
  'drafted', 'co', 'helped', 'worked', 'responsible', 'experienced', 'proven', 'strong', 'solid', 'skilled',
  'dedicated', 'motivated', 'hardworking', 'hard', 'currently', 'seeking', 'looking', 'excellent', 'good', 'fluent',
  'proficient', 'able', 'willing', 'highly', 'basic', 'working', 'familiar', 'eager', 'keen', 'committed',
  'reliable', 'creative', 'analytical', 'organised', 'organized', 'confident', 'friendly', 'over', 'nearly',
  'about', 'around', 'approximately', 'more', 'most', 'some', 'several', 'many', 'two', 'three', 'four', 'five',
  'first', 'second', 'third', 'one', 'when', 'while', 'after', 'before', 'during', 'since', 'through', 'within',
  'across', 'every', 'daily', 'weekly', 'monthly', 'annual', 'annually', 'end', 'full', 'part', 'hands', 'cross',
  'a', 'an', 'the', 'my', 'our', 'this', 'that', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'to', 'and', 'as',
  'also', 'including', 'includes', 'used', 'using', 'achieved', 'recognised', 'recognized', 'awarded', 'selected',
  'member', 'volunteer', 'participated', 'partnered', 'collaborated', 'hold', 'has', 'have', 'work', 'speak',
  'passed', 'completed', 'earned', 'obtained', 'graduated', 'holder', 'holding', 'gained',
]);

/** Single-letter / word grades used in O/L and A/L result tables. */
export const GRADE = /^(a\+?|b|c|s|w|f|distinction|credit|merit|pass)$/i;

/** Aliases applied after lower-casing, before tokenising. Longest first. Each maps to one canonical form. */
export const ALIASES: [RegExp, string][] = [
  [/\bb\s?\.?\s?sc\b\.?/g, ' bachelor of science '],
  [/\bm\s?\.?\s?sc\b\.?/g, ' master of science '],
  [/\bb\s?\.?\s?com\b\.?/g, ' bachelor of commerce '],
  [/\bmba\b/g, ' master of business administration '],
  [/\bbba\b/g, ' bachelor of business administration '],
  [/\bhnd\b/g, ' higher national diploma '],
  [/\bhons\b\.?/g, ' honours '],
  [/\bhonors\b/g, ' honours '],
  [/\bms\s+(excel|word|office|powerpoint|access|project|outlook)\b/g, ' microsoft $1 '],
  [/\bpower\s*bi\b/g, ' power bi '],
  [/\bg\s?\.?\s?c\s?\.?\s?e\b\.?/g, ' gce '],
  [/\bo\s*\/\s*l\b|\bordinary level\b/g, ' ol '],
  [/\ba\s*\/\s*l\b|\badvanced level\b/g, ' al '],
  [/\(?\s*private\s*\)?\s+limited\b/g, ' pvt ltd '],
  [/\(\s*pvt\s*\.?\s*\)|\bpvt\b\.?/g, ' pvt '],
  [/\blimited\b/g, ' ltd '],
  [/\bco\s?\.?\s?ltd\b/g, ' company ltd '],
  [/\bdept\b\.?/g, ' department '],
  [/\bmgmt\b/g, ' management '],
  [/\bjr\b\.?/g, ' junior '],
  [/\bsr\b\.?/g, ' senior '],
  [/\bexec\b\.?/g, ' executive '],
  [/\basst\b\.?/g, ' assistant '],
  [/\bper\s+cent\b/g, ' percent '],
  [/\bjavascript\b|\bjs\b/g, ' javascript '],
  [/\bnode\s*\.?\s*js\b/g, ' nodejs '],
  [/\bpostgres(?:ql)?\b/g, ' postgresql '],
  [/\bk8s\b/g, ' kubernetes '],
  [/\bgoogle\s+cloud(?:\s+platform)?\b/g, ' gcp '],
  [/\bamazon\s+web\s+services\b/g, ' aws '],
  [/&/g, ' and '],
];

export const WORD_NUMBERS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, hundred: 100,
};

export const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7,
  july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12,
  december: 12,
};

/** Words in an entity that mark its kind, for the report. */
export const EMPLOYER_HINTS = /\b(ltd|plc|pvt|inc|llc|bank|holdings|group|company|corporation|corp|industries|limited|lanka|ceylon|associates|partners|solutions|technologies|systems|services|hospital|hotel|hotels|ministry|board|authority)\b/i;
export const TITLE_HINTS = /\b(engineer|developer|manager|analyst|accountant|officer|executive|assistant|intern|trainee|lead|director|clerk|consultant|specialist|coordinator|supervisor|administrator|associate|designer|architect|teacher|lecturer|instructor|cashier|representative|agent|head|chief|controller|auditor|secretary|technician|operator)\b/i;
export const INSTITUTION_HINTS = /\b(university|college|institute|school|vidyalaya|vidyalayam|academy|campus|faculty|nibm|sliit|nsbm|iit|apiit|icbt|esoft)\b/i;
