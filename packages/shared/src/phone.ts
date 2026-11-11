/**
 * Phone numbers are the identity anchor for both the owner and staff, since
 * staff have no email address. We normalise to E.164 for Kenya only for now;
 * another country is a small change here and nowhere else.
 */

const KENYA_MOBILE = /^\+254[17]\d{8}$/;

/**
 * Accepts 0712345678, 0112345678, 712345678, 112345678, 254712345678,
 * +254712345678 and the same written with spaces, dashes or brackets.
 *
 * Returns null when the number is not a valid Kenyan mobile number.
 */
export function normalizePhone(input: string): string | null {
  const cleaned = input.replace(/[\s()\-.]/g, '');

  let national: string;
  if (cleaned.startsWith('+254')) national = cleaned.slice(4);
  else if (cleaned.startsWith('254')) national = cleaned.slice(3);
  else if (cleaned.startsWith('0')) national = cleaned.slice(1);
  else national = cleaned;

  if (!/^[17]\d{8}$/.test(national)) return null;

  const e164 = `+254${national}`;
  return KENYA_MOBILE.test(e164) ? e164 : null;
}

/** Renders +254712345678 as 0712 345 678 for display. */
export function formatPhone(e164: string): string {
  if (!KENYA_MOBILE.test(e164)) return e164;
  const national = e164.slice(4);
  return `0${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
}

/** Last four digits, safe to show on a shared screen. */
export function maskPhone(e164: string): string {
  return e164.length >= 4 ? `••• ${e164.slice(-4)}` : '•••';
}
