export function pdfWithPages(texts: readonly string[]) {
  if (!texts.length) throw new Error("PDF fixture needs at least one page");
  const pageReferences = texts.map((_, index) => 3 + index);
  const fontReference = 3 + texts.length;
  const contentReferences = texts.map((_, index) => fontReference + 1 + index);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageReferences.map((reference) => `${reference} 0 R`).join(" ")}] /Count ${texts.length} >>`,
    ...texts.map((_, index) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontReference} 0 R >> >> /Contents ${contentReferences[index]} 0 R >>`),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...texts.map((text) => {
      const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
      const stream = escaped ? `BT /F1 10 Tf 36 740 Td (${escaped}) Tj ET` : "";
      return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    }),
  ];
  let raw = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(raw.length);
    raw += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = raw.length;
  raw += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  raw += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  raw += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(raw);
}

export function pdfWithText(text: string) {
  return pdfWithPages([text]);
}
