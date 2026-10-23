import { savedTables, viewSavedData } from './presentation.mjs';

/** RFC 4180 cell escaping plus spreadsheet-formula neutralization for strings. */
export function csvCell(value) {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (typeof value === 'string' && /^[\s\u0000-\u001f]*[=+\-@\t\r\n]/u.test(value)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function filename(value, extension) {
  const base = typeof value === 'string' ? value.replace(/\.(json|csv)$/i, '').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^\.+/, '').slice(0, 100) : '';
  return `${base || 'apiosk-saved-result'}.${extension}`;
}

/** In-memory download payload. It never writes files or contacts a source. */
export function exportResult(raw, options = {}) {
  const format = options.format ?? 'json';
  if (format === 'json') {
    const value = options.table_id || options.tableId || options.block_id || options.columns || options.filter || options.view ? viewSavedData(raw, options) : raw;
    const text = JSON.stringify(value, null, 2);
    if (text === undefined) throw new TypeError('The saved result is not JSON serializable.');
    return { format, mimeType: 'application/json', filename: filename(options.filename, format), text, bytes: Buffer.byteLength(text), local_only: true };
  }
  if (format !== 'csv') throw new TypeError('format must be json or csv.');
  const tables = savedTables(raw);
  if (tables.length > 1 && !options.table_id && !options.tableId && !options.block_id) throw new Error(`Choose table_id for CSV export: ${tables.map(table => table.id).join(', ')}`);
  const table = viewSavedData(raw, options);
  const text = [table.columns.map(column => csvCell(column.label)).join(','), ...table.rows.map(row => row.map(csvCell).join(','))].join('\r\n') + '\r\n';
  return { format, mimeType: 'text/csv;charset=utf-8', filename: filename(options.filename, format), text, bytes: Buffer.byteLength(text), rowCount: table.rows.length, table_id: table.id, counts: table.counts, local_only: true, notice: 'Formula-like strings are prefixed with an apostrophe for spreadsheet safety; JSON preserves exact original strings.' };
}
