export const HIDDEN_PHONE_LABEL = "[phone number hidden]";
export const HIDDEN_EMAIL_LABEL = "[email hidden]";

const PHONE_CANDIDATE_RE = /(^|[^\w@])(\+?\d[\d\s().-]{8,}\d)(?=$|[^\w@])/g;

export function redactPhoneNumbers(value: string): string {
  return value.replace(PHONE_CANDIDATE_RE, (match, prefix: string, candidate: string) => {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) return match;
    return `${prefix}${HIDDEN_PHONE_LABEL}`;
  });
}

export function redactContactHandle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "me" || trimmed === "unknown") return trimmed;
  const withoutPhones = redactPhoneNumbers(trimmed);
  if (withoutPhones !== trimmed) return withoutPhones;
  if (/^[^@\s]+@[^@\s]+$/.test(trimmed)) return HIDDEN_EMAIL_LABEL;
  return trimmed;
}
