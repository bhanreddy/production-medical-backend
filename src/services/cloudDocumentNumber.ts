import { queryRaw } from "../lib/postgresDb";

/** A cloud sequence remains unique across multiple API instances. */
export async function cloudDocumentNumber(clinicId: string, prefix = "CLI") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) =>
    parts.find((value) => value.type === type)!.value;
  const day = `${part("year")}-${part("month")}-${part("day")}`;
  const [row] = await queryRaw<{ last_value: number }>(
    `INSERT INTO clinic_invoice_sequences(clinic_id, sequence_date, last_value)
    VALUES (?, ?, 1) ON CONFLICT (clinic_id, sequence_date)
    DO UPDATE SET last_value = clinic_invoice_sequences.last_value + 1 RETURNING last_value`,
    [clinicId, day],
  );
  return `${prefix}-${day.replace(/-/g, "")}-${String(row.last_value).padStart(4, "0")}`;
}
