/**
 * Regenerates the resume-import fixtures. Not part of the test run; the outputs are committed.
 *
 *   node test/fixtures/resume/make-fixtures.ts
 *
 * Needs Google Chrome (Playwright drives it to print the PDFs and take the screenshots).
 * Every person, employer and number in these CVs is invented.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const out = (name: string) => path.join(DIR, name);

// ---------------------------------------------------------------- PDFs and images (Chrome)

const SCANNED_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body { font-family: Georgia, serif; font-size: 15px; line-height: 1.4; margin: 40px 50px; color: #222; background: #fbfaf6; }
h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 18px 0 6px; } ul { margin: 4px 0; } p { margin: 4px 0; }
</style></head><body>
<h1>Ruwan Pathirana</h1>
<p>Kurunegala · 076 228 4410 · ruwan.p@example.lk</p>
<h2>Objective</h2>
<p>Seeking a position as an Electrician / Maintenance Technician in a manufacturing plant.</p>
<h2>Experience</h2>
<p><b>Maintenance Technician</b>, Wayamba Garments (Pvt) Ltd, Kurunegala (2021 – Present)</p>
<ul><li>Maintain 120 industrial sewing machines and the factory's 400 kVA generator.</li><li>Carry out monthly preventive maintenance checklists.</li></ul>
<h2>Qualifications</h2>
<ul><li>NVQ Level 4 in Electrician, Vocational Training Authority, 2020</li><li>G.C.E. O/L 2015: 7 passes including Mathematics and Science</li></ul>
</body></html>`;

async function chromeOutputs(): Promise<void> {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage();
    for (const name of ['modern', 'traditional', 'two-column']) {
      await page.goto(`file://${out(`${name}.html`)}`);
      await page.pdf({ path: out(`${name}.pdf`), format: 'A4', preferCSSPageSize: true, printBackground: true });
    }
    // Word-style: bullet glyphs as text, justified and hyphenated text, sidebar on the right,
    // two pages with a running "Page n of m" footer.
    await page.goto(`file://${out('word-style.html')}`);
    await page.pdf({
      path: out('word-style.pdf'),
      format: 'A4',
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="font-size:8pt;width:100%;text-align:center">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    });

    // A "photo" of a CV and a scanned PDF: pixels only, no text layer.
    await page.setViewportSize({ width: 794, height: 760 });
    await page.setContent(SCANNED_HTML);
    const jpg = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: true });
    fs.writeFileSync(out('photo.jpg'), jpg);
    await page.setContent(
      `<html><body style="margin:0"><img style="width:100%;display:block" src="data:image/jpeg;base64,${jpg.toString('base64')}"></body></html>`,
    );
    await page.pdf({ path: out('scanned.pdf'), format: 'A4', margin: { top: '0', bottom: '0', left: '0', right: '0' } });
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- DOCX (hand-built OOXML)

/** The DOCX's content. The test asserts that every heading, bullet and paragraph survives. */
export const DOCX_SOURCE = {
  title: 'Dilshan Jayasuriya',
  paragraphs: [
    'Negombo · 077 903 1182 · dilshan.j@example.lk',
    'Sales executive with five years of field sales experience in fast-moving consumer goods across the Western and North Western provinces.',
    'Diploma in Sales and Marketing Management, Sri Lanka Institute of Marketing (SLIM), 2019',
    'G.C.E. Advanced Level 2016, Commerce stream, Maris Stella College, Negombo',
  ],
  headings: ['Profile', 'Experience', 'Sales Executive, Ceylon Spice Foods (Pvt) Ltd, Negombo', 'Sales Representative, Lakpura Beverages, Kurunegala', 'Education', 'Skills'],
  bullets: [
    'Grew the Negombo territory from Rs. 4.2 million to Rs. 6.9 million in monthly sales between 2022 and 2025.',
    'Opened 85 new retail outlets in Gampaha district.',
    'Trained four new sales representatives on route planning and stock rotation.',
    'Covered 140 retail outlets on a weekly route.',
    'Won the regional salesperson of the year award in 2021.',
    'Key account management',
    'Route planning and merchandising',
    'MS Excel and SAP Business One',
  ],
  link: { text: 'LinkedIn profile', url: 'https://www.linkedin.com/in/dilshan-j-example' },
  table: [
    ['Year', 'Target achieved'],
    ['2023', '104%'],
    ['2024', '111%'],
  ],
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const run = (t: string, bold = false) => `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const para = (t: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${run(t)}</w:p>`;
const bullet = (t: string) => `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run(t)}</w:p>`;
const cell = (t: string) => `<w:tc><w:p>${run(t)}</w:p></w:tc>`;

function documentXml(): string {
  const s = DOCX_SOURCE;
  const b = s.bullets;
  const body = [
    para(s.title, 'Heading1'),
    para(s.paragraphs[0]),
    `<w:p><w:hyperlink r:id="rIdLink">${run(s.link.text)}</w:hyperlink></w:p>`,
    para(s.headings[0], 'Heading2'),
    para(s.paragraphs[1]),
    para(s.headings[1], 'Heading2'),
    para(s.headings[2], 'Heading3'),
    `<w:p>${run('January 2022 – Present', true)}</w:p>`,
    bullet(b[0]),
    bullet(b[1]),
    bullet(b[2]),
    `<w:tbl>${s.table.map((r) => `<w:tr>${r.map(cell).join('')}</w:tr>`).join('')}</w:tbl>`,
    para(s.headings[3], 'Heading3'),
    `<w:p>${run('March 2020 – December 2021', true)}</w:p>`,
    bullet(b[3]),
    bullet(b[4]),
    para(s.headings[4], 'Heading2'),
    para(s.paragraphs[2]),
    para(s.paragraphs[3]),
    para(s.headings[5], 'Heading2'),
    bullet(b[5]),
    bullet(b[6]),
    bullet(b[7]),
  ].join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr/></w:body></w:document>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${DOCX_SOURCE.link.url}" TargetMode="External"/>
</Relationships>`;

/** A minimal ZIP writer (deflate), enough for an OOXML package. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, deflated);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + deflated.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function writeDocx(): void {
  fs.writeFileSync(
    out('sales.docx'),
    zip({
      '[Content_Types].xml': CONTENT_TYPES,
      '_rels/.rels': ROOT_RELS,
      'word/document.xml': documentXml(),
      'word/styles.xml': STYLES,
      'word/numbering.xml': NUMBERING,
      'word/_rels/document.xml.rels': DOC_RELS,
    }),
  );
  fs.writeFileSync(out('sales.docx.json'), `${JSON.stringify(DOCX_SOURCE, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeDocx();
  await chromeOutputs();
  for (const f of fs.readdirSync(DIR).sort()) console.log(f.padEnd(24), fs.statSync(out(f)).size);
}
