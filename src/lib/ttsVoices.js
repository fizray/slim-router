import { VOICE_FETCHERS } from "open-sse/handlers/ttsCore.js";

const LANG_NAMES = new Intl.DisplayNames(["en"], { type: "language" });

function langName(code) {
  try { return LANG_NAMES.of(code); } catch { return code; }
}

export async function listTtsVoices(provider = "gemini", langFilter = null) {
  const fetcher = VOICE_FETCHERS[provider];
  if (!fetcher) {
    return { error: `Provider '${provider}' does not support voice listing` };
  }

  const raw = await fetcher();
  let voices = raw.map((v) => ({
    id: v.voice_id,
    name: v.name,
    locale: v.labels?.language || "en",
    lang: (v.labels?.language || "en").split("-")[0],
    country: "",
    countryName: "",
    langName: langName((v.labels?.language || "en").split("-")[0]),
    gender: v.labels?.gender || "",
    category: v.category,
  }));

  if (langFilter) voices = voices.filter((v) => v.lang === langFilter);

  const byLang = {};
  for (const v of voices) {
    const key = v.lang;
    if (!byLang[key]) byLang[key] = { code: key, name: v.langName, voices: [] };
    byLang[key].voices.push(v);
  }

  const languages = Object.values(byLang).sort((a, b) => a.name.localeCompare(b.name));
  return { voices, languages, byLang };
}
