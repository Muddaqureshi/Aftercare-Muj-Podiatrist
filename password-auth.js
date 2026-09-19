export const PASSWORD_ITERATIONS = 600000;
const hex = bytes => [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");

export async function passwordProof(password, salt) {
  if (typeof password !== "string" || password.length < 12 || password.length > 128) throw new Error("Use your password of 12 to 128 characters.");
  if (!/^[a-f0-9]{64}$/.test(salt || "")) throw new Error("Login configuration is unavailable. Refresh and try again.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bytes = Uint8Array.from(salt.match(/../g), pair => parseInt(pair, 16));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: bytes, iterations: PASSWORD_ITERATIONS, hash: "SHA-256" }, key, 256));
}

// Store a digest of the derived proof, never the proof that authorizes a login.
export async function proofVerifier(proof) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof)));
}

export function sameVerifier(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left || "") || !/^[a-f0-9]{64}$/.test(right || "")) return false;
  let different = 0;
  for (let i = 0; i < 64; i++) different |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return different === 0;
}
