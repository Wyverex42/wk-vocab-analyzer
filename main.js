// ==UserScript==
// @name         Vocab Analyzer
// @namespace    wyverex
// @version      1.0.0
// @description  <TODO>
// @author       Andreas Krügersen-Clark
// @match        https://www.wanikani.com/
// @match        https://www.wanikani.com/dashboard
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

  const wkof = window.wkof;
  const shared = {
    vocab: undefined,
    kanji: undefined,
  };

  wkof.include("ItemData");
  wkof.ready("ItemData").then(startup).catch(loadError);

  function loadError(e) {
    console.error('Failed to load data from WKOF for "Daily Vocab Planner"', e);
  }

  function startup() {
    const vocabConfig = { wk_items: { options: { subjects: true }, filters: { srs: "init", item_type: "voc" } } };
    wkof.ItemData.get_items(vocabConfig).then(processVocab);
    const kanjiConfig = { wk_items: { options: { subjects: true }, filters: { level: "1..+0", item_type: "kanji" } } };
    wkof.ItemData.get_items(kanjiConfig).then(processKanji);
  }

  function processVocab(items) {
    shared.vocab = items;
    if (shared.kanji !== undefined) {
      processData();
    }
  }

  function processKanji(items) {
    shared.kanji = items;
    if (shared.vocab !== undefined) {
      processData();
    }
  }

  // ====================================================================================
  function processData() {
    if (window.location.href.includes("subject-lessons/picker")) {
      const vocabResults = analyzeVocab();
      annotateVocabInLessonPicker(vocabResults);
    }
  }

  function analyzeVocab() {
    let result = {};
    for (let vocab of shared.vocab) {
      const data = vocab.data;
      const kanjiReadings = getKanjiReadings(data.component_subject_ids);

      for (let reading of data.readings) {
        if (reading.primary && reading.accepted_answer) {
          const tokens = getCharacterTokens(data.characters);
          const kanjiMatches = matchKanjiReadings(tokens, reading.reading, kanjiReadings);
          const isEasy = kanjiMatches !== undefined && kanjiMatches.reduce((p, c) => p && c.primary, true);
          result[vocab.id] = { isEasy };
        }
      }
    }
    return result;
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
      kanjiReadings[kanji.characters] = { primary: primaryReadings, secondary: secondaryReadings };
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
      // Now check which reading this is
      const kReadings = kanjiReadings[cToken.value];
      for (let primary of kReadings.primary) {
        if (reading.startsWith(primary)) {
          const subResult = matchKanjiReadings(tokens.slice(1), reading.slice(primary.length), kanjiReadings);
          if (subResult !== undefined) {
            return [{ character: cToken.value, reading: primary, primary: true }, ...subResult];
          }
        }
      }
      for (let secondary of kReadings.secondary) {
        if (reading.startsWith(secondary)) {
          const subResult = matchKanjiReadings(tokens.slice(1), reading.slice(secondary.length), kanjiReadings);
          if (subResult !== undefined) {
            return [{ character: cToken.value, reading: secondary, primary: false }, ...subResult];
          }
        }
      }
      return undefined;
    } else {
      const length = cToken.value.length;
      if (length > reading.length) {
        // This is a character vs reading mismatch due to a non-matching kanji
        return undefined;
      }
      return matchKanjiReadings(tokens.slice(1), reading.slice(length), kanjiReadings);
    }
  }

  // ====================================================================================
  function annotateVocabInLessonPicker(vocabResults) {
    const subjectElements = document.querySelectorAll("[data-subject-id]");
    for (let element of subjectElements) {
      const id = element.getAttribute("data-subject-id");
      if (id in vocabResults && vocabResults[id].isEasy) {
        const target = element.firstElementChild.firstElementChild.firstElementChild;
        const computedStyle = window.getComputedStyle(target);
        target.style.boxShadow = computedStyle.boxShadow + ",0 0 3px 3px green";
      }
    }
  }
})();
