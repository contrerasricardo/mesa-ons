// Descifra docs/data/emisores.json en el navegador (WebCrypto). Mismo formato que scripts/exportar_emisores.py:
// PBKDF2-SHA256 → clave AES-256-GCM; `ct` trae el tag de 16 bytes al final.
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export async function descifrar(sobre, clave) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(clave), "PBKDF2", false, ["deriveKey"]);
  const k = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: b64(sobre.sal), iterations: sobre.iter },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const texto = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(sobre.iv) }, k, b64(sobre.ct));
  return JSON.parse(new TextDecoder().decode(texto));
}
