/**
 * Prina vendor license signing public key (T8.2) — not a secret; embedded in the image.
 * The matching private key is held only by the license server (prina-license). Key rotation = minor release.
 */
export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEADn9zcYyrm70H+M3lczxIC+dq+zv3CfxrlztoYw/Upd8=
-----END PUBLIC KEY-----
`;
