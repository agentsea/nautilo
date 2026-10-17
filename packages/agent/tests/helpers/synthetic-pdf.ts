/** A synthetic, valid PDF with one text line per page. No real documents are used. */
export function syntheticPdf(lines: readonly string[], appendPageOperators = ""): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${lines.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${lines.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, line] of lines.entries()) {
    const escaped = line.replace(/([\\()])/g, "\\$1");
    const stream = (line ? `BT /F1 12 Tf 40 700 Td (${escaped}) Tj ET` : "") + appendPageOperators;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${Math.max(612, line.length * 12)} 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
