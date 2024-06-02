// ==UserScript==
// @name         Vocab Analyzer
// @namespace    wyverex
// @version      1.0.1
// @description  Colors vocabulary on the lesson picker based on whether their readings are known
// @author       Andreas Krügersen-Clark
// @match        https://www.wanikani.com/subject-lessons/picker
// @grant        none
// @require      https://unpkg.com/wanakana
// @license      MIT
// @run-at       document-end
// ==/UserScript==

(function () {
  if (!window.wkof) {
    alert(
      '"Wanikani Levels Overview Plus" script requires Wanikani Open Framework.\nYou will now be forwarded to installation instructions.'
    );
    window.location.href = "https://community.wanikani.com/t/instructions-installing-wanikani-open-framework/28549";
    return;
  }

  const StoreName = "cachedReadings";

  const wkof = window.wkof;
  const shared = {
    db: undefined,

    vocab: undefined,
    kanji: undefined,
    learnedVocabProcessed: false,

    // KanjiId -> [learned readings]
    lastReadingCacheTime: new Date(0),
    readingsCache: {},
  };

  wkof.include("ItemData");
  wkof.ready("ItemData").then(openDB).catch(loadError);

  function loadError(e) {
    console.error('Failed to load data from WKOF for "Vocab Analyzer"', e);
  }

  function openDB() {
    const dbRequest = window.indexedDB.open("wk-vocab-analyzer", 1);
    dbRequest.onerror = (event) => {
      console.error("Could not open database for Vocab Analyzer. Analyzing vocab with learned, secondary readings is not supported.");
      startup();
    };
    dbRequest.onsuccess = (event) => {
      shared.db = event.target.result;
      const transaction = shared.db.transaction([StoreName], "readonly");
      const store = transaction.objectStore(StoreName);
      const request = store.get("main");
      request.onsuccess = () => {
        const data = request.result;
        shared.lastReadingCacheTime = data.lastReadingCacheTime;
        shared.readingsCache = data.cache;
        startup();
      };
    };
    dbRequest.onupgradeneeded = (event) => {
      const db = event.target.result;
      const store = db.createObjectStore(StoreName, { keyPath: "id" });
      store.add({ id: "main", lastReadingCacheTime: new Date(0), cache: {} });
    };
  }

  function startup() {
    const kanjiConfig = { wk_items: { options: { subjects: true }, filters: { level: "1..+0", item_type: "kanji" } } };
    wkof.ItemData.get_items(kanjiConfig).then(processKanji);
  }

  function processKanji(items) {
    shared.kanji = items;

    if (shared.db) {
      // Get all learned vocab
      const config = {
        wk_items: { options: { subjects: true, assignments: true }, filters: { srs: { value: [-1, 0], invert: true }, item_type: "voc" } },
      };
      wkof.ItemData.get_items(config).then(cacheNewlyLearnedReadings);
    } else {
      processVocab();
    }
  }

  function cacheNewlyLearnedReadings(items) {
    if (items.length > 0) {
      let hasUpdates = false;
      for (let vocab of items) {
        const startTime = new Date(vocab.assignments.started_at);
        if (startTime > shared.lastReadingCacheTime) {
          const analysis = analyzeVocab(vocab);
          if (analysis) {
            for (let kanji of analysis) {
              if (shared.readingsCache[kanji.id] === undefined) {
                shared.readingsCache[kanji.id] = new Set();
              }
              shared.readingsCache[kanji.id].add(kanji.reading);
              hasUpdates = true;
            }
          }
        }
      }

      if (hasUpdates) {
        const transaction = shared.db.transaction([StoreName], "readwrite");
        const store = transaction.objectStore(StoreName);
        store.put({ id: "main", lastReadingCacheTime: new Date(), cache: shared.readingsCache });
      }
    }

    processVocab();
  }

  function processVocab() {
    // Get unlocked, not yet learned vocab
    const vocabConfig = { wk_items: { options: { subjects: true }, filters: { srs: "init", item_type: "voc" } } };
    wkof.ItemData.get_items(vocabConfig).then((items) => {
      shared.vocab = items;
      processData();
    });
  }

  // ====================================================================================
  function processData() {
    if (window.location.href.includes("subject-lessons/picker")) {
      const uiResults = {};
      for (let vocab of shared.vocab) {
        const analysis = analyzeVocab(vocab);
        const isEasy = analysis !== undefined && analysis.reduce((p, c) => p && c.primary, true);
        let isNewReading = false;
        if (!isEasy) {
          if (analysis) {
            for (const kanji of analysis) {
              if (!kanji.primary) {
                const cachedReadings = shared.readingsCache[kanji.id];
                if (!cachedReadings || !cachedReadings.has(kanji.reading)) {
                  isNewReading = true;
                  break;
                }
              }
            }
          } else {
            isNewReading = true;
          }
        }
        uiResults[vocab.id] = { isEasy, isNewReading };
      }
      console.log(uiResults);

      annotateVocabInLessonPicker(uiResults);
    }
  }

  // Returns [kanjiMatch]
  function analyzeVocab(vocab) {
    const data = vocab.data;
    const kanjiReadings = getKanjiReadings(data.component_subject_ids);

    for (let reading of data.readings) {
      if (reading.primary && reading.accepted_answer) {
        const tokens = getCharacterTokens(data.characters);
        const kanjiMatches = matchKanjiReadings(tokens, reading.reading, kanjiReadings);
        return kanjiMatches;
      }
    }
  }

  // Returns an object of <kanji character> -> { primaryReading[], secondaryReading[] }
  function getKanjiReadings(kanjiIds) {
    const kanjiById = wkof.ItemData.get_index(shared.kanji, "subject_id");
    let kanjiReadings = {};
    for (let id of kanjiIds) {
      let primaryReadings = [];
      let secondaryReadings = [];
      const kanji = kanjiById[id].data;
      for (let reading of kanji.readings) {
        if (reading.primary && reading.accepted_answer) {
          primaryReadings.push(reading.reading);
        } else {
          secondaryReadings.push(reading.reading);
        }
      }
      kanjiReadings[kanji.characters] = { id, primary: primaryReadings, secondary: secondaryReadings };
    }
    return kanjiReadings;
  }

  function getCharacterTokens(characters) {
    let result = [];
    const tokens = wanakana.tokenize(characters, { detailed: true });
    for (let token of tokens) {
      if (token.type === "kanji") {
        // The tokenizer returns strings of subsequent kanji as a single token, e.g. 地中海. Split them
        const subTokens = [...token.value];
        for (let sub of subTokens) {
          result.push({ type: "kanji", value: sub });
        }
      } else {
        result.push(token);
      }
    }
    return result;
  }

  function matchKanjiReadings(tokens, reading, kanjiReadings) {
    if (tokens.length == 0) {
      return reading.length == 0 ? [] : undefined;
    }

    const cToken = tokens[0];
    if (cToken.type === "kanji") {
      // Check which reading this is
      const kReadings = kanjiReadings[cToken.value];
      for (let primary of kReadings.primary) {
        if (reading.startsWith(primary)) {
          const subResult = matchKanjiReadings(tokens.slice(1), reading.slice(primary.length), kanjiReadings);
          if (subResult !== undefined) {
            return [{ id: kReadings.id, character: cToken.value, reading: primary, primary: true }, ...subResult];
          }
        }
      }
      for (let secondary of kReadings.secondary) {
        if (reading.startsWith(secondary)) {
          const subResult = matchKanjiReadings(tokens.slice(1), reading.slice(secondary.length), kanjiReadings);
          if (subResult !== undefined) {
            return [{ id: kReadings.id, character: cToken.value, reading: secondary, primary: false }, ...subResult];
          }
        }
      }
      return undefined;
    } else if (cToken.type === "hiragana" || cToken.type === "katakana") {
      const length = cToken.value.length;
      if (length > reading.length) {
        // This is a character vs reading mismatch due to a non-matching kanji
        return undefined;
      }
      return matchKanjiReadings(tokens.slice(1), reading.slice(length), kanjiReadings);
    } else {
      // Skip this token, it doesn't participate in the reading
      return matchKanjiReadings(tokens.slice(1), reading, kanjiReadings);
    }
  }

  // ====================================================================================
  function annotateVocabInLessonPicker(vocabResults) {
    const subjectElements = document.querySelectorAll("[data-subject-id]");
    for (let element of subjectElements) {
      const id = element.getAttribute("data-subject-id");
      if (id in vocabResults) {
        const target = element.firstElementChild.firstElementChild.firstElementChild;

        if (vocabResults[id].isEasy) {
          target.style.color = "#A1FA4F";
        } else if (vocabResults[id].isNewReading) {
          target.style.color = "#EB3324";
        } else {
          target.style.color = "#3487FF";
        }
      }
    }
  }
})();
