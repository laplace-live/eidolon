// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/core/src/transcriptions/language.ts@ce8f8bc, packages/soniox/src/stt.ts@ce8f8bc and packages/elevenlabs/src/stt.ts@ce8f8bc
//
// pipedog's language codes, and how Soniox and ElevenLabs name each one. A code outside them
// reaches the provider as given.

const LANGUAGES: ReadonlySet<string> = new Set(
  `af af-ZA am am-ET ar ar-AE ar-BH ar-DZ ar-EG ar-IQ ar-JO ar-KW ar-LB ar-LY ar-MA ar-OM ar-QA
  ar-SA ar-SY ar-TN ar-XA ar-YE ar-001 as as-IN ast az az-AZ ba be be-BY bg bg-BG bn bn-BD
  bn-IN bo br brx brx-IN bs bs-BA ca ca-ES ceb ceb-PH ckb ckb-IQ ckb-IR cmn cmn-CN cs cs-CZ cy
  cy-GB da da-DK de de-AT de-BE de-CH de-DE doi doi-IN el el-GR en en-AB en-AU en-CA en-GB
  en-GH en-HK en-IE en-IN en-KE en-NG en-NZ en-PH en-SG en-TZ en-US en-WL en-ZA eo es es-AR
  es-BO es-CL es-CO es-CR es-CU es-DO es-EC es-ES es-GQ es-GT es-HN es-MX es-NI es-PA es-PE
  es-PR es-PY es-SV es-US es-UY es-VE es-419 et et-EE eu eu-ES fa fa-AF fa-IR ff fi fi-FI fil
  fil-PH fo fr fr-BE fr-CA fr-CH fr-FR ga ga-IE gd gl gl-ES gu gu-IN ha haw he he-IL hi hi-IN
  hr hr-HR ht ht-HT hu hu-HU hy hy-AM id id-ID ig is is-IS it it-IT it-CH iu-Cans iu-Cans-CA
  iu-Latn iu-Latn-CA ja ja-JP jv jv-ID jv-JV jw ka ka-GE kea kab kab-DZ kk kk-KZ km km-KH kn
  kn-IN kok kok-IN ko ko-KR ks ks-IN ku ky ky-KG la la-VA lb lb-LU ln lo lo-LA lt lt-LT lg luo
  lv lv-LV mg mg-MG mi mk mk-MK mai mai-IN ml ml-IN mn mn-MN mni mni-IN mr mr-IN ms ms-MY mt
  mt-MT my my-MM mymr nb nb-NO no nn nn-NO ne ne-IN ne-NP nl nl-BE nl-NL nso ny oc or or-IN pa
  pa-IN pl pl-PL ps ps-AF pt pt-BR pt-PT ro ro-RO ru ru-RU sa sa-IN sat sat-IN sd sd-IN si
  si-LK sk sk-SK sl sl-SI sn so so-SO sq sq-AL sr sr-RS sr-Latn sr-Latn-RS su su-ID sv sv-SE sw
  sw-BI sw-KE sw-RW sw-TZ sw-UG ta ta-IN ta-LK ta-MY ta-SG te te-IN tg th th-TH tk tl tr tr-TR
  tt ug uk uk-UA umb ur ur-IN ur-PK uz uz-UZ vi vi-VN wo wuu wuu-CN yi yo yue yue-CN zh zh-CN
  zh-CN-guangxi zh-CN-henan zh-CN-liaoning zh-CN-shaanxi zh-CN-shandong zh-CN-sichuan zh-HK
  zh-TW xh-ZA zu zu-ZA`.split(/\s+/),
);

// Only the codes ElevenLabs names differently from their base language.
const ELEVENLABS: Readonly<Record<string, string>> = {
  af: "afr",
  am: "amh",
  ar: "ara",
  as: "asm",
  az: "aze",
  be: "bel",
  bg: "bul",
  bn: "ben",
  bs: "bos",
  ca: "cat",
  cs: "ces",
  cy: "cym",
  da: "dan",
  de: "deu",
  el: "ell",
  en: "eng",
  es: "spa",
  et: "est",
  fa: "fas",
  ff: "ful",
  fi: "fin",
  fr: "fra",
  ga: "gle",
  gl: "glg",
  gu: "guj",
  ha: "hau",
  he: "heb",
  hi: "hin",
  hr: "hrv",
  hu: "hun",
  hy: "hye",
  id: "ind",
  ig: "ibo",
  is: "isl",
  it: "ita",
  ja: "jpn",
  jv: "jav",
  ka: "kat",
  kk: "kaz",
  km: "khm",
  kn: "kan",
  ko: "kor",
  ku: "kur",
  ky: "kir",
  lb: "ltz",
  ln: "lin",
  lo: "lao",
  lt: "lit",
  lg: "lug",
  lv: "lav",
  mi: "mri",
  mk: "mkd",
  ml: "mal",
  mn: "mon",
  mr: "mar",
  ms: "msa",
  mt: "mlt",
  my: "mya",
  no: "nor",
  ne: "nep",
  nl: "nld",
  ny: "nya",
  oc: "oci",
  or: "ori",
  pa: "pan",
  pl: "pol",
  ps: "pus",
  pt: "por",
  ro: "ron",
  ru: "rus",
  sd: "snd",
  sk: "slk",
  sl: "slv",
  sn: "sna",
  so: "som",
  sr: "srp",
  sv: "swe",
  sw: "swa",
  ta: "tam",
  te: "tel",
  tg: "tgk",
  th: "tha",
  tr: "tur",
  uk: "ukr",
  ur: "urd",
  uz: "uzb",
  vi: "vie",
  wo: "wol",
  zh: "zho",
  "xh-ZA": "xho",
  zu: "zul",
};

/** `en` for `en-US`. */
function baseCode(language: string): string {
  return (language.split("-")[0] as string).toLowerCase();
}

/** Soniox's language hints: the base language, Bokmål as Norwegian; none for an unknown code. */
export function sonioxHints(language: string | null): string[] | null {
  if (language === null || !LANGUAGES.has(language)) return null;
  const base = baseCode(language);
  return [base === "nb" ? "no" : base];
}

/** ElevenLabs' `language_code`: its ISO 639-3 name for a code pipedog knows. */
export function elevenLabsLanguage(language: string): string {
  if (!LANGUAGES.has(language)) return language;
  const base = baseCode(language);
  return ELEVENLABS[language] ?? ELEVENLABS[base] ?? base;
}

/** OpenAI's transcription language: the base code. */
export function openaiLanguage(language: string): string {
  return baseCode(language);
}
