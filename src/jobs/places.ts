/**
 * Sri Lankan place parsing. The district slug this returns is part of job identity (tier 2,
 * `identity.ts`): changing what a place maps to re-keys every stored job in that place, so every
 * change here needs a case in test/places.test.ts and test/identity.test.ts.
 */

export const DISTRICTS = [
  'Colombo', 'Gampaha', 'Kalutara', 'Kandy', 'Matale', 'Nuwara Eliya', 'Galle', 'Matara', 'Hambantota',
  'Jaffna', 'Kilinochchi', 'Mannar', 'Vavuniya', 'Mullaitivu', 'Batticaloa', 'Ampara', 'Trincomalee',
  'Kurunegala', 'Puttalam', 'Anuradhapura', 'Polonnaruwa', 'Badulla', 'Monaragala', 'Ratnapura', 'Kegalle',
] as const;
export type District = (typeof DISTRICTS)[number];

/** Cities, towns and suburbs → district. Keys are lower-case, single-spaced. */
const TOWNS: Record<string, District> = {};
function add(district: District, names: string): void {
  for (const n of names.split(',')) TOWNS[n.trim()] = district;
}
add('Colombo', [
  'colombo fort', 'pettah', 'kollupitiya', 'kolpetty', 'bambalapitiya', 'wellawatte', 'wellawatta', 'borella',
  'dematagoda', 'grandpass', 'kotahena', 'maradana', 'slave island', 'cinnamon gardens', 'havelock town',
  'kirulapone', 'kirulapana', 'narahenpita', 'mattakkuliya', 'modara', 'mutwal', 'dehiwala', 'dehiwela',
  'mount lavinia', 'mt lavinia', 'ratmalana', 'moratuwa', 'nugegoda', 'maharagama', 'kotte',
  'sri jayawardenepura kotte', 'sri jayewardenepura kotte', 'rajagiriya', 'battaramulla', 'malabe', 'kaduwela',
  'athurugiriya', 'homagama', 'kottawa', 'piliyandala', 'boralesgamuwa', 'kesbewa', 'pannipitiya', 'kolonnawa',
  'wellampitiya', 'avissawella', 'padukka', 'hanwella', 'kohuwala', 'pelawatte', 'thalawathugoda', 'mirihana',
  'kalubowila', 'nawala', 'koswatte', 'angoda', 'kalubowila', 'nugegoda', 'pita kotte', 'ethul kotte',
  'welikada', 'wattegedara', 'hokandara', 'kahathuduwa', 'meegoda', 'godagama',
  'angulana', 'mulleriyawa', 'rathmalana', 'kotikawatta', 'kotikawaththa',
].join(','));
add('Gampaha', [
  'negombo', 'katunayake', 'katunayaka', 'biyagama', 'wattala', 'ja ela', 'jaela', 'kelaniya', 'kadawatha',
  'kiribathgoda', 'ragama', 'kandana', 'seeduwa', 'minuwangoda', 'veyangoda', 'nittambuwa', 'mirigama',
  'divulapitiya', 'ekala', 'peliyagoda', 'hendala', 'mahara', 'delgoda', 'kirindiwela', 'ganemulla', 'yakkala',
  'kandana', 'welisara', 'mabole', 'enderamulla', 'hunupitiya', 'dompe', 'gampaha town', 'kochchikade',
].join(','));
add('Kalutara', 'panadura, horana, beruwala, beruwela, aluthgama, matugama, wadduwa, bandaragama, ingiriya, bulathsinhala, payagala, kalutara south, kalutara north');
add('Kandy', 'hanthana, peradeniya, katugastota, gampola, nawalapitiya, kundasale, digana, pilimathalawa, akurana, kadugannawa, tennekumbura, ampitiya, gelioya, kandy city');
add('Matale', 'dambulla, galewela, ukuwela, rattota, sigiriya, naula');
add('Nuwara Eliya', 'hatton, nanu oya, talawakele, thalawakele, maskeliya, walapane, ragala, nuwaraeliya');
add('Galle', 'hikkaduwa, ambalangoda, karapitiya, baddegama, elpitiya, unawatuna, koggala, habaraduwa, ahangama, bentota, balapitiya');
add('Matara', 'weligama, akuressa, dikwella, kamburupitiya, hakmana, devinuwara, mirissa');
add('Hambantota', 'tangalle, tangalla, tissamaharama, ambalantota, beliatta, weeraketiya, sooriyawewa');
add('Jaffna', 'chavakachcheri, point pedro, nallur, kankesanthurai, chunnakam, kopay, jaffna town');
add('Kilinochchi', 'paranthan, pallai');
add('Mannar', 'talaimannar, madhu');
add('Vavuniya', 'cheddikulam, nedunkeni');
add('Mullaitivu', 'puthukudiyiruppu, oddusuddan');
add('Batticaloa', 'kattankudy, kattankudi, eravur, valaichchenai, kalkudah, pasikudah');
add('Ampara', 'kalmunai, akkaraipattu, sammanthurai, dehiattakandiya, uhana, pottuvil, arugam bay');
add('Trincomalee', 'kinniya, kantale, mutur, nilaveli');
add('Kurunegala', 'kuliyapitiya, pannala, narammala, wariyapola, polgahawela, mawathagama, nikaweratiya, alawwa, ibbagamuwa, giriulla');
add('Puttalam', 'chilaw, wennappuwa, marawila, nattandiya, dankotuwa, kalpitiya, anamaduwa, madampe');
add('Anuradhapura', 'kekirawa, medawachchiya, eppawala, mihintale, thambuttegama, tambuttegama, galenbindunuwewa');
add('Polonnaruwa', 'kaduruwela, hingurakgoda, medirigiriya, minneriya');
add('Badulla', 'bandarawela, haputale, mahiyanganaya, welimada, ella, passara, diyatalawa, hali ela');
add('Monaragala', 'moneragala, wellawaya, buttala, bibile, kataragama, siyambalanduwa');
add('Ratnapura', 'rathnapura, balangoda, embilipitiya, pelmadulla, eheliyagoda, kuruwita, kahawatta, kalawana');
add('Kegalle', 'kegalla, mawanella, warakapola, rambukkana, ruwanwella, yatiyantota, dehiowita, deraniyagala, kitulgala');
for (const d of DISTRICTS) TOWNS[d.toLowerCase()] = d;
TOWNS['nuwaraeliya'] = 'Nuwara Eliya';

/** Neighbouring districts, used to widen a search (PRD §5.4a). Made symmetric below. */
const NEIGHBOURS: Partial<Record<District, District[]>> = {
  Colombo: ['Gampaha', 'Kalutara', 'Kegalle', 'Ratnapura'],
  Gampaha: ['Colombo', 'Kurunegala', 'Puttalam', 'Kegalle'],
  Kalutara: ['Colombo', 'Ratnapura', 'Galle'],
  Kandy: ['Matale', 'Kegalle', 'Nuwara Eliya', 'Kurunegala', 'Badulla'],
  Matale: ['Kandy', 'Kurunegala', 'Anuradhapura', 'Polonnaruwa'],
  'Nuwara Eliya': ['Kandy', 'Badulla', 'Ratnapura', 'Kegalle'],
  Galle: ['Kalutara', 'Ratnapura', 'Matara'],
  Matara: ['Galle', 'Ratnapura', 'Hambantota'],
  Hambantota: ['Matara', 'Ratnapura', 'Monaragala'],
  Jaffna: ['Kilinochchi'],
  Kilinochchi: ['Jaffna', 'Mullaitivu', 'Mannar'],
  Mannar: ['Kilinochchi', 'Mullaitivu', 'Vavuniya', 'Anuradhapura', 'Puttalam'],
  Vavuniya: ['Mannar', 'Mullaitivu', 'Anuradhapura', 'Trincomalee'],
  Mullaitivu: ['Kilinochchi', 'Mannar', 'Vavuniya', 'Trincomalee'],
  Batticaloa: ['Trincomalee', 'Polonnaruwa', 'Ampara', 'Badulla'],
  Ampara: ['Batticaloa', 'Polonnaruwa', 'Badulla', 'Monaragala'],
  Trincomalee: ['Mullaitivu', 'Vavuniya', 'Anuradhapura', 'Polonnaruwa', 'Batticaloa'],
  Kurunegala: ['Puttalam', 'Anuradhapura', 'Matale', 'Kandy', 'Kegalle', 'Gampaha'],
  Puttalam: ['Mannar', 'Anuradhapura', 'Kurunegala', 'Gampaha'],
  Anuradhapura: ['Mannar', 'Vavuniya', 'Trincomalee', 'Polonnaruwa', 'Matale', 'Kurunegala', 'Puttalam'],
  Polonnaruwa: ['Anuradhapura', 'Trincomalee', 'Batticaloa', 'Ampara', 'Badulla', 'Matale'],
  Badulla: ['Kandy', 'Nuwara Eliya', 'Ratnapura', 'Monaragala', 'Ampara', 'Polonnaruwa', 'Batticaloa'],
  Monaragala: ['Badulla', 'Ampara', 'Hambantota', 'Ratnapura'],
  Ratnapura: ['Kegalle', 'Colombo', 'Kalutara', 'Galle', 'Matara', 'Hambantota', 'Monaragala', 'Badulla', 'Nuwara Eliya'],
  Kegalle: ['Kurunegala', 'Kandy', 'Nuwara Eliya', 'Ratnapura', 'Colombo', 'Gampaha'],
};
const ADJ = new Map<District, Set<District>>(DISTRICTS.map((d) => [d, new Set<District>()]));
for (const [d, list] of Object.entries(NEIGHBOURS) as [District, District[]][]) {
  for (const n of list) {
    ADJ.get(d)!.add(n);
    ADJ.get(n)!.add(d);
  }
}

export function districtSlug(d: string): string {
  return d.toLowerCase().replace(/\s+/g, '-');
}

/** A district by name or slug, case-insensitive ("nuwara-eliya", "Nuwara Eliya"), else null. */
export function findDistrict(name: string | null | undefined): District | null {
  if (!name) return null;
  const k = name.trim().toLowerCase().replace(/[-_\s]+/g, ' ');
  return DISTRICTS.find((d) => d.toLowerCase() === k) ?? null;
}

/** Districts next to `district` (alphabetical), for widening a search. Unknown district → []. */
export function nearbyDistricts(district: string): District[] {
  const d = findDistrict(district);
  return d ? [...ADJ.get(d)!].sort() : [];
}

const REMOTE = /\b(remote(ly)?|work(ing)? from home|wfh|telecommut\w*|home[ -]based|anywhere|virtual)\b/i;
/** Words that say how or how widely, not where. */
const PLACEHOLDER = /^(on ?site|hybrid|island ?wide|all ?island|any ?where|any|multiple( locations?)?|various( locations?)?|\d+ locations?|n ?a|none|not specified|unknown|location|tbd|tba|other|others|remote|work from home|wfh|online|overseas|abroad|foreign)$/;
const SRI_LANKA = /\b(sri ?lanka|ceylon|srilanka)\b|(^|[\s,])(lk|lka)($|[\s,])/gi;
const IS_SRI_LANKA = new RegExp(SRI_LANKA.source, 'i');
/** "Galle Road", "Kandy Rd": a street, not a town. */
const STREET = /\b([a-z]+(?: [a-z]+)?) (road|rd|street|st|mawatha|mw|lane|avenue|ave|place|pl|junction)\b/g;

const MAX_WORDS = Math.max(...Object.keys(TOWNS).map((k) => k.split(' ').length));

function norm(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export interface Place {
  /** The district, as in DISTRICTS ("Colombo"), or null. The first one named when there are several. */
  district: string | null;
  /**
   * The place part of identity tier 2. District slugs ("colombo", "colombo,kandy" when several);
   * "lk" when only the country is named; "t:<words>" for a place outside Sri Lanka or one the list
   * does not know (kept so "Driver, Dubai" and "Driver, Doha" stay apart); null when the text names
   * no place at all ("Remote", "Island wide").
   */
  slug: string | null;
  remote: boolean;
}

export function parsePlace(location: string | null | undefined): Place {
  const raw = (location ?? '').trim();
  if (!raw) return { district: null, slug: null, remote: false };
  const remote = REMOTE.test(raw);

  let text = norm(raw);
  // Colombo postal zones: "Colombo 03", "Col-7", "Colombo 15".
  const districts: District[] = [];
  const push = (d: District) => {
    if (!districts.includes(d)) districts.push(d);
  };
  // Find matches in reading order: scan tokens left to right, longest phrase first.
  text = text.replace(/\bcol(?:ombo)? ?0?([1-9]|1[0-5])\b/g, ' colombo ');
  text = text.replace(STREET, (whole, name: string) => {
    // Keep a town the street is named after only if it is not followed by a real place later.
    return TOWNS[name] ? ' ' : whole;
  });
  const words = text.split(' ').filter(Boolean);
  const leftover: string[] = [];
  for (let i = 0; i < words.length; ) {
    let hit = 0;
    for (let n = Math.min(MAX_WORDS, words.length - i); n >= 1; n--) {
      const d = TOWNS[words.slice(i, i + n).join(' ')];
      if (d) {
        push(d);
        hit = n;
        break;
      }
    }
    if (hit) i += hit;
    else leftover.push(words[i++]);
  }

  if (districts.length) {
    return { district: districts[0], slug: districts.map(districtSlug).sort().join(','), remote };
  }

  // No Sri Lankan town. Country only, a foreign place, or no place at all.
  const parts = raw
    .split(/[;,/|()\n]+|\s-\s/)
    .map((p) => norm(p.replace(SRI_LANKA, ' ')))
    .map((p) => p.replace(REMOTE, ' ').replace(/\s+/g, ' ').trim())
    .filter((p) => p && !PLACEHOLDER.test(p) && !/^\d+$/.test(p));
  if (parts.length) return { district: null, slug: `t:${[...new Set(parts)].sort().join(',')}`, remote };
  if (IS_SRI_LANKA.test(norm(raw))) return { district: null, slug: 'lk', remote };
  return { district: null, slug: null, remote };
}

/** True when the whole text is one Sri Lankan place name: a district, a known town, or a Colombo postal
 *  zone ("Colombo 03", "Col 7"). "Colombo Branch" or "Kandy Road" is not. */
export function isPlaceName(text: string | null | undefined): boolean {
  const t = norm(text ?? '');
  if (!t) return false;
  if (/^col(?:ombo)? ?0?([1-9]|1[0-5])$/.test(t)) return true;
  return TOWNS[t] !== undefined;
}

/**
 * A job title without a trailing place segment that some boards append ("Sales Executive | Colombo 03",
 * "Call Center Executive (Kiribathgoda)", "Teller - Kandy"), so the same job keys alike everywhere.
 * Only a segment that is wholly a Sri Lankan place name is removed; a title is never emptied.
 */
export function stripTitlePlace(title: string): string {
  let t = title.trim();
  for (let i = 0; i < 2; i++) {
    const m = /^(.*\S)\s*(?:\(([^()]+)\)|\s[|\-–—,/]\s*([^|\-–—,/()]+))\s*$/.exec(t);
    if (!m) break;
    const seg = m[2] ?? m[3];
    if (!isPlaceName(seg) || !m[1].trim()) break;
    t = m[1].trim().replace(/\s*[|\-–—,/]$/, '').trim();
  }
  return t || title.trim();
}

// ---------------------------------------------------------------- overseas jobs (PRD §4 non-goal)

/** Countries, regions and big cities that clearly are not Sri Lanka, as they appear in job-board
 *  location fields. Conservative on purpose: an unknown place is kept (it may be a small Sri Lankan
 *  town), so only names that cannot be a Sri Lankan town are listed. Lower-case, single-spaced. */
const FOREIGN_PLACES = [
  // Gulf and Middle East
  'oman', 'muscat', 'salalah', 'sohar', 'uae', 'u a e', 'united arab emirates', 'dubai', 'abu dhabi', 'sharjah', 'ajman',
  'fujairah', 'ras al khaimah', 'al ain', 'saudi', 'saudi arabia', 'ksa', 'k s a', 'riyadh', 'jeddah', 'jiddah', 'dammam',
  'khobar', 'al khobar', 'mecca', 'makkah', 'medina', 'madinah', 'jubail', 'tabuk', 'qatar', 'doha', 'kuwait', 'bahrain',
  'manama', 'jordan', 'amman', 'lebanon', 'beirut', 'iraq', 'erbil', 'baghdad', 'israel', 'tel aviv', 'cyprus', 'egypt',
  'cairo', 'turkey', 'istanbul', 'gulf', 'gcc', 'middle east',
  // Asia and Pacific
  'maldives', 'india', 'chennai', 'bangalore', 'bengaluru', 'mumbai', 'new delhi', 'delhi', 'hyderabad', 'kolkata', 'pune',
  'bangladesh', 'dhaka', 'pakistan', 'karachi', 'lahore', 'nepal', 'kathmandu', 'singapore', 'malaysia', 'kuala lumpur',
  'penang', 'thailand', 'bangkok', 'vietnam', 'ho chi minh', 'hanoi', 'indonesia', 'jakarta', 'philippines', 'manila',
  'china', 'shanghai', 'beijing', 'shenzhen', 'hong kong', 'taiwan', 'japan', 'tokyo', 'osaka', 'south korea', 'korea',
  'seoul', 'australia', 'sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'new zealand', 'auckland', 'wellington nz',
  'seychelles', 'mauritius',
  // Europe and the Americas
  'united kingdom', 'uk', 'u k', 'england', 'scotland', 'london', 'manchester', 'ireland', 'dublin', 'germany', 'berlin',
  'munich', 'france', 'paris', 'italy', 'milan', 'rome', 'spain', 'madrid', 'portugal', 'lisbon', 'netherlands', 'amsterdam',
  'belgium', 'brussels', 'switzerland', 'zurich', 'geneva', 'austria', 'vienna', 'sweden', 'stockholm', 'norway', 'oslo',
  'denmark', 'copenhagen', 'finland', 'helsinki', 'poland', 'warsaw', 'krakow', 'romania', 'bucharest', 'croatia', 'zagreb',
  'serbia', 'belgrade', 'hungary', 'budapest', 'czech republic', 'czechia', 'prague', 'greece', 'athens', 'malta', 'russia',
  'moscow', 'ukraine', 'europe', 'european union', 'usa', 'u s a', 'united states', 'new york', 'california', 'texas',
  'canada', 'toronto', 'vancouver', 'montreal', 'mexico', 'brazil', 'argentina',
  // Africa
  'kenya', 'nairobi', 'nigeria', 'lagos', 'south africa', 'johannesburg', 'cape town', 'tanzania', 'uganda', 'ethiopia',
  // Board labels for overseas postings
  'foreign job', 'foreign jobs', 'overseas', 'abroad', 'global worldwide',
];
const FOREIGN_RE = new RegExp(`(^| )(${[...FOREIGN_PLACES].sort((a, b) => b.length - a.length).join('|')})( |$)`);

/**
 * True when a location clearly names a place outside Sri Lanka ("Muscat, Oman", "Dubai - UAE",
 * "Foreign Job", "Global Worldwide"). False for any text that names a Sri Lankan district or town
 * (a job "Colombo or Dubai" is kept), and for unknown places, which may be small Sri Lankan towns.
 * "Remote" alone is not foreign.
 */
export function isForeignPlace(location: string | null | undefined): boolean {
  if (!location || !location.trim()) return false;
  if (parsePlace(location).district) return false;
  // "Dubai Road" is a street name, not Dubai.
  const text = norm(location).replace(STREET, ' ').replace(/\s+/g, ' ').trim();
  return FOREIGN_RE.test(text);
}

/**
 * An overseas job (PRD §4: not in scope): a country code that is not LK, or a location that clearly
 * names a foreign place. A null country code alone says nothing.
 */
export function isForeignJob(job: { country_code?: string | null; location?: string | null }): boolean {
  const cc = job.country_code?.trim().toUpperCase();
  if (cc && cc !== 'LK') return true;
  return isForeignPlace(job.location);
}
