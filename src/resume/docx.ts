/** DOCX → HTML (mammoth) → Markdown (turndown), with tables kept as Markdown tables. */
import mammoth from 'mammoth';
import TurndownService from 'turndown';

export interface DocxConversion {
  markdown: string;
  headings: number;
  bullets: number;
  tables: number;
  links: number;
  images: number;
  warnings: string[];
}

type DomNode = {
  nodeName: string;
  nodeType: number;
  childNodes: ArrayLike<DomNode>;
  textContent: string | null;
  innerHTML?: string;
};

const children = (n: DomNode) => Array.from(n.childNodes);

/** The rows of a table, whether or not they sit inside thead/tbody. */
function tableRows(table: DomNode): DomNode[] {
  const rows: DomNode[] = [];
  for (const c of children(table)) {
    if (c.nodeName === 'TR') rows.push(c);
    else if (['THEAD', 'TBODY', 'TFOOT'].includes(c.nodeName)) rows.push(...children(c).filter((r) => r.nodeName === 'TR'));
  }
  return rows;
}

export function htmlToMarkdown(html: string): string {
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '_' });
  td.remove(['img', 'style', 'script']);
  td.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const rows = tableRows(node as unknown as DomNode).map((tr) =>
        children(tr)
          .filter((c) => c.nodeName === 'TD' || c.nodeName === 'TH')
          .map((c) => td.turndown(c.innerHTML ?? c.textContent ?? '').replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|').trim()),
      );
      if (!rows.length) return '';
      const width = Math.max(...rows.map((r) => r.length));
      const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
      const firstIsHeader = children(tableRows(node as unknown as DomNode)[0]).some((c) => c.nodeName === 'TH');
      const head = firstIsHeader ? pad(rows[0]) : Array(width).fill('');
      const body = firstIsHeader ? rows.slice(1) : rows;
      const line = (cells: string[]) => `| ${cells.map((c) => c || ' ').join(' | ')} |`;
      return `\n\n${[line(head), `|${' --- |'.repeat(width)}`, ...body.map((r) => line(pad(r)))].join('\n')}\n\n`;
    },
  });
  return td
    .turndown(html)
    .replace(/^(\s*)-\s{2,}/gm, '$1- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function docxToMarkdown(buffer: Buffer): Promise<DocxConversion> {
  let images = 0;
  const result = await mammoth.convertToHtml(
    { buffer },
    {
      // A CV photo is not needed to match jobs and would bloat the Markdown.
      convertImage: mammoth.images.imgElement(async () => {
        images++;
        return { src: '' };
      }),
    },
  );
  const markdown = htmlToMarkdown(result.value);
  const warnings = result.messages
    .filter((m) => m.type === 'warning' || m.type === 'error')
    .map((m) => m.message)
    // Unrecognised paragraph styles are normal in CVs and lose only formatting.
    .filter((m) => !/^Unrecognised (paragraph|run) style/.test(m))
    .slice(0, 10);
  if (images) warnings.push(`The Word file has ${images} picture(s) (often a photo). They were left out of the Markdown.`);
  return {
    markdown: markdown ? `${markdown}\n` : '',
    headings: (markdown.match(/^#{1,6} /gm) ?? []).length,
    bullets: (markdown.match(/^\s*(-|\d+\.) /gm) ?? []).length,
    tables: (markdown.match(/^\| --- /gm) ?? []).length,
    links: (markdown.match(/\]\((https?:|mailto:)/g) ?? []).length,
    images,
    warnings,
  };
}
