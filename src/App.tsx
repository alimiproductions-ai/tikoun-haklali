/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import confetti from 'canvas-confetti';
import { Moon, Sun, ArrowLeft, Wand2, RotateCcw, CheckCircle2, X, Mic, MicOff, Volume2, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, Modality } from "@google/genai";

// --- UTILS ---
const createWavHeader = (pcmData: Uint8Array, sampleRate: number) => {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  // RIFF identifier
  view.setUint32(0, 0x52494646, false); // "RIFF"
  // file length
  view.setUint32(4, 36 + pcmData.length, true);
  // RIFF type
  view.setUint32(8, 0x57415645, false); // "WAVE"
  // format chunk identifier
  view.setUint32(12, 0x666d7420, false); // "fmt "
  // format chunk length
  view.setUint32(16, 16, true);
  // sample format (raw PCM)
  view.setUint16(20, 1, true);
  // channel count
  view.setUint16(22, 1, true);
  // sample rate
  view.setUint32(24, sampleRate, true);
  // byte rate (sample rate * block align)
  view.setUint32(28, sampleRate * 2, true);
  // block align (channel count * bytes per sample)
  view.setUint16(32, 2, true);
  // bits per sample
  view.setUint16(34, 16, true);
  // data chunk identifier
  view.setUint32(36, 0x64617461, false); // "data"
  // data chunk length
  view.setUint32(40, pcmData.length, true);

  return new Uint8Array(header);
};

const stripNikoud = (text: string) => {
  return text.replace(/[\u0591-\u05C7]/g, "");
};

const cleanHebrew = (text: string) => {
  return stripNikoud(text).replace(/[^\u05D0-\u05EA]/g, "");
};

const normalizeHebrewForSpeech = (text: string) => {
  let cleaned = stripNikoud(text);
  
  // Normalize Sofit letters to regular letters to improve recognition
  cleaned = cleaned.replace(/ך/g, "כ")
                   .replace(/ם/g, "מ")
                   .replace(/ן/g, "נ")
                   .replace(/ף/g, "פ")
                   .replace(/ץ/g, "צ");

  // The Tetragrammaton (יהוה) is always pronounced as Adonai (אדני)
  cleaned = cleaned.replace(/יהוה/g, "אדני").replace(/אדוני/g, "אדני");
  
  // Phonetic indulgence: Group similar sounding letters to improve recognition
  // This addresses the request to be indulgent with Bet/Vet/Vav and other phonemes.
  
  // 1. Labials: Bet/Vet (ב), Vav (ו), Pe/Fe (פ) -> all to 'ב'
  cleaned = cleaned.replace(/[ופ]/g, "ב");
  
  // 2. Gutturals/Velars/Aspirates: Het (ח), Khaf (כ), Kof (ק), He (ה) -> all to 'כ'
  // This satisfies the /k/ <-> /h/ and /k/ <-> /kh/ requirements.
  cleaned = cleaned.replace(/[חקה]/g, "כ");
  
  // 3. Dentals: Tet (ט), Tav (ת) -> all to 'ט'
  cleaned = cleaned.replace(/ת/g, "ט");
  
  // 4. Sibilants: Samekh (ס), Sin (ש) -> all to 'ס'
  cleaned = cleaned.replace(/ש/g, "ס");
  
  // 5. Laryngeals: Aleph (א), Ayin (ע) -> all to 'א'
  cleaned = cleaned.replace(/ע/g, "א");

  // 6. Vowel /i/ leniency: Remove 'י' (Yod) as it often represents the /i/ vowel (Hiriq)
  // This makes the system lenient whether the vowel is articulated strongly or not.
  cleaned = cleaned.replace(/י/g, "");
  
  // Keep only Hebrew letters
  return cleaned.replace(/[^\u05D0-\u05EA]/g, "");
};

const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

// --- COMPONENTS ---
const ConfirmModal = ({ isOpen, title, yesText, noText, onConfirm, onCancel }: { isOpen: boolean, title: string, yesText: string, noText: string, onConfirm: () => void, onCancel: () => void }) => {
  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4"
        >
          <motion.div 
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.8, opacity: 0 }}
            className="bg-white p-8 rounded-[3rem] shadow-[0_12px_0_rgba(0,0,0,0.1)] max-w-xs w-full text-center border-8 border-[var(--bordeaux)]"
          >
            <h3 className="text-3xl font-black mb-8 text-[var(--text-main)] leading-tight uppercase tracking-tight">{title}</h3>
            <div className="flex gap-4 justify-center">
              <button 
                onClick={onCancel}
                className="flex-1 px-4 py-4 rounded-3xl border-4 border-[var(--gris)] text-[var(--text-muted)] font-black hover:bg-[var(--gris)] transition-all active:translate-y-1"
              >
                {noText}
              </button>
              <button 
                onClick={onConfirm}
                className="flex-1 px-4 py-4 rounded-3xl bg-[var(--jaune)] text-white font-black shadow-[0_6px_0_rgb(194,65,12)] hover:scale-105 active:translate-y-1 transition-all"
              >
                {yesText}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

const Tutorial = ({ isOpen, lang, onFinish, onSkip, onAwardBadge }: { isOpen: boolean, lang: string, onFinish: () => void, onSkip: () => void, onAwardBadge: (id: string) => void }) => {
  const [step, setStep] = useState(0);
  const [activeWords, setActiveWords] = useState<Set<number>>(new Set());
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState<number | null>(null);
  const t = i18n[lang];
  
  const tutorialPhrase = "נַ נַחְ נַחְמָ נַחְמָן מְאוּמָן";
  const words = tutorialPhrase.split(' ');

  const speakWord = (word: string, index: number) => {
    if (isSpeaking !== null || !word) return;
    setIsSpeaking(index);
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = 'he-IL';
    utterance.rate = 0.85;
    utterance.pitch = 0.8;
    utterance.onend = () => setIsSpeaking(null);
    utterance.onerror = () => setIsSpeaking(null);
    window.speechSynthesis.speak(utterance);
  };

  const steps = [
    { title: t.tutorial_step1_title, msg: t.tutorial_step1_msg, icon: "👋" },
    { title: t.tutorial_step2_title, msg: t.tutorial_step2_msg, icon: "📖" },
    { title: t.tutorial_step3_title, msg: t.tutorial_step3_msg, icon: "🎤" },
    { title: t.tutorial_step4_title, msg: t.tutorial_step4_msg, icon: "✨" },
    { title: t.tutorial_step5_title, msg: t.tutorial_step5_msg, icon: "🏆" },
  ];

  const handleNext = () => {
    if (step < steps.length - 1) {
      // Clear words when entering the practice step (step 3)
      if (step === 2) {
        setActiveWords(new Set());
      }
      setStep(step + 1);
    } else {
      onAwardBadge('nanach');
      onFinish();
    }
  };

  const handlePrev = () => {
    if (step > 0) setStep(step - 1);
  };

  const handleRestart = () => {
    setStep(0);
    setActiveWords(new Set());
    setIsListening(false);
  };

  useEffect(() => {
    if (!SpeechRecognition || !isListening || !isOpen) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'he-IL';

    recognition.onresult = (event: any) => {
      const results = event.results;
      for (let i = event.resultIndex; i < results.length; i++) {
        const transcript = results[i][0].transcript.toLowerCase();
        const normSpoken = normalizeHebrewForSpeech(transcript);
        
        if (!normSpoken) continue;

        words.forEach((word, index) => {
          const normTarget = normalizeHebrewForSpeech(word);
          if (normSpoken.includes(normTarget)) {
            setActiveWords(prev => {
              const next = new Set(prev);
              next.add(index);
              return next;
            });
          }
        });
      }
    };

    recognition.onerror = (e: any) => console.error('Tutorial Mic Error:', e.error);
    
    try {
      recognition.start();
    } catch (e) {
      console.warn('Tutorial Mic Start Error:', e);
    }
    
    return () => {
      try {
        recognition.stop();
      } catch (e) {
        // ignore
      }
    };
  }, [isListening, isOpen]);

  if (!isOpen) return null;

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 bg-black/80 backdrop-blur-md z-[200] flex items-center justify-center p-4 overflow-y-auto"
    >
      <div className="bg-white dark:bg-zinc-900 p-6 md:p-10 rounded-[3rem] shadow-2xl max-w-2xl w-full border-8 border-[var(--jaune)] relative">
        <button 
          onClick={onSkip}
          className="absolute top-6 right-6 text-[var(--text-muted)] font-bold hover:text-[var(--text-main)] transition-colors"
        >
          {t.tutorial_skip} ✕
        </button>

        <div className="text-center mb-8">
          <div className="text-6xl mb-4">{steps[step].icon}</div>
          <h2 className="text-4xl font-black mb-4 text-[var(--text-main)] dark:text-white uppercase tracking-tight">
            {steps[step].title}
          </h2>
          <p className="text-xl text-[var(--text-muted)] dark:text-zinc-400 leading-relaxed" dangerouslySetInnerHTML={{ __html: steps[step].msg }} />
        </div>

        {/* Step Content */}
        <div className="min-h-[200px] flex flex-col items-center justify-center mb-8">
          {step === 1 && (
            <div className="flex flex-wrap justify-center gap-4 dir-rtl" dir="rtl">
              {words.slice(0, 3).map((word, i) => (
                <motion.div
                  key={i}
                  onClick={() => {
                    const next = new Set(activeWords);
                    if (next.has(i)) next.delete(i);
                    else next.add(i);
                    setActiveWords(next);
                  }}
                  className={`
                    inline-block mx-2 my-1 px-6 py-3 rounded-2xl cursor-pointer transition-all border-b-8 relative text-3xl md:text-4xl font-black
                    ${activeWords.has(i)
                      ? 'bg-[var(--vert)] text-white border-green-700 shadow-inner'
                      : 'bg-white dark:bg-zinc-700 border-[var(--gris)] text-[var(--text-muted)] hover:border-[var(--bordeaux)]'}
                  `}
                >
                  <div className="flex items-center gap-3">
                    {word}
                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        speakWord(word, i);
                      }}
                      className={`p-2 rounded-full hover:bg-black/10 transition-colors ${isSpeaking === i ? 'text-[var(--jaune)]' : ''}`}
                    >
                      {isSpeaking === i ? <Loader2 size={24} className="animate-spin" /> : <Volume2 size={24} />}
                    </button>
                  </div>
                </motion.div>
              ))}
            </div>
          )}

          {step === 2 && (
            <div className="flex flex-col items-center gap-6">
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                onClick={() => setIsListening(!isListening)}
                className={`p-8 rounded-full border-8 transition-all shadow-2xl ${
                  isListening 
                    ? 'bg-[var(--jaune)] border-orange-700 text-white animate-pulse' 
                    : 'bg-white border-[var(--gris)] text-[var(--text-muted)]'
                }`}
              >
                {isListening ? <Mic size={48} /> : <MicOff size={48} />}
              </motion.button>
              <p className="font-black text-xl text-[var(--text-main)] dark:text-white uppercase">
                {isListening ? t.micOn : t.micOff}
              </p>
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col items-center gap-6 w-full">
              <div className="bg-zinc-100 dark:bg-zinc-800 p-8 rounded-[2.5rem] flex flex-wrap justify-center gap-4 dir-rtl w-full" dir="rtl">
                {words.map((word, i) => (
                  <motion.div
                    key={i}
                    onClick={() => {
                      const next = new Set(activeWords);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      setActiveWords(next);
                    }}
                    className={`
                      text-3xl md:text-5xl font-black px-6 py-3 rounded-2xl transition-all duration-300 border-b-8
                      ${activeWords.has(i) 
                        ? 'bg-[var(--jaune)] text-white border-orange-700 shadow-inner' 
                        : 'bg-white dark:bg-zinc-700 text-[var(--text-main)] dark:text-white border-[var(--gris)] shadow-md'}
                      ${isSpeaking === i ? 'ring-4 ring-[var(--bordeaux)] animate-pulse' : ''}
                    `}
                  >
                    <div className="flex items-center gap-3">
                      {word}
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          speakWord(word, i);
                        }}
                        className={`p-2 rounded-full hover:bg-black/10 transition-colors ${isSpeaking === i ? 'text-[var(--jaune)]' : ''}`}
                      >
                        {isSpeaking === i ? <Loader2 size={24} className="animate-spin" /> : <Volume2 size={24} />}
                      </button>
                    </div>
                  </motion.div>
                ))}
              </div>
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                onClick={() => setIsListening(!isListening)}
                className={`p-4 rounded-full border-4 transition-all shadow-lg ${
                  isListening 
                    ? 'bg-[var(--jaune)] border-orange-700 text-white animate-pulse' 
                    : 'bg-white border-[var(--gris)] text-[var(--text-muted)]'
                }`}
              >
                {isListening ? <Mic size={24} /> : <MicOff size={24} />}
              </motion.button>
            </div>
          )}

          {step === 0 && (
            <div className="text-8xl animate-bounce">✨</div>
          )}

          {step === 4 && (
            <div className="text-center">
              <div className="text-8xl mb-4">🎉</div>
              <p className="text-2xl font-black text-[var(--vert)] uppercase tracking-widest">{t.wellDone}</p>
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="flex flex-col gap-4">
          <div className="flex justify-between items-center gap-4">
            <button 
              onClick={handlePrev}
              disabled={step === 0}
              className={`flex-1 py-4 rounded-3xl text-xl font-black transition-all border-b-4 ${
                step === 0 
                  ? 'bg-zinc-100 text-zinc-300 border-zinc-200 cursor-not-allowed' 
                  : 'bg-white border-[var(--gris)] text-[var(--text-main)] hover:bg-zinc-50 active:translate-y-1'
              }`}
            >
              ← {t.tutorial_prev}
            </button>

            <button 
              onClick={handleNext}
              className="flex-[2] py-5 rounded-3xl bg-[var(--jaune)] text-white text-2xl font-black shadow-[0_8px_0_rgb(194,65,12)] hover:scale-105 active:translate-y-1 transition-all"
            >
              {step === steps.length - 1 ? t.tutorial_finish : t.tutorial_next}
            </button>
          </div>

          {step > 0 && (
            <button 
              onClick={handleRestart}
              className="text-[var(--text-muted)] font-bold hover:text-[var(--bordeaux)] transition-colors uppercase tracking-widest text-sm"
            >
              ↺ {t.tutorial_restart}
            </button>
          )}
        </div>

        {/* Progress Dots */}
        <div className="flex justify-center gap-2 mt-8">
          {steps.map((_, i) => (
            <div 
              key={i} 
              className={`h-3 w-3 rounded-full transition-all ${i === step ? 'w-8 bg-[var(--jaune)]' : 'bg-zinc-300 dark:bg-zinc-700'}`}
            />
          ))}
        </div>
      </div>
    </motion.div>
  );
};

// --- I18N DATA ---
const i18n: Record<string, any> = {
  he: {
    mainTitle: "תִּיקוּן הַכְּלָלִי", completed: "השלמת", outOf: "מתוך 10 פרקים", reset: "איפוס", back: "חזרה", selectAll: "בחר הכל 🪄", wellDone: "!כל הכבוד", returnMenu: "חזרה לתפריט", finalTitle: "אלוף התיקון הכללי!", finalMsg: "סיימת את כל הפרקים!<br>מגיע לך פרס מיוחד מאבא ואמא", restart: "התחל מחדש", confirmReset: "לאפס הכל?", confirmRemove: "להסיר את הסימון מפרק ", yes: "כן", no: "לא",
    ranks: ["מתחילים!", "ניצוץ ראשון", "אור קטן", "מתמיד צעיר", "נחישות", "חצי הדרך!", "כוח הקדושה", "מפיץ אור", "כמעט שם", "שיא המתח", "אלוף התיקון!"],
    micOn: "מיקרופון פועל", micOff: "מיקרופון כבוי", micError: "שגיאת מיקרופון", micNetwork: "שגיאת רשת. מנסה שוב...",
    points: "נקודות", streak: "רצף ימים", badges: "תגים",
    badge_first_word: "מילה ראשונה", badge_first_word_desc: "קראת את המילה הראשונה שלך!",
    badge_first_psalm: "חלוץ תהילים", badge_first_psalm_desc: "סיימת את הפרק הראשון שלך!",
    badge_halfway: "גיבור חצי הדרך", badge_halfway_desc: "סיימת 5 פרקים!",
    badge_tikun_master: "מאסטר התיקון", badge_tikun_master_desc: "סיימת את כל 10 הפרקים!",
    badge_streak_3: "עקבי", badge_streak_3_desc: "רצף של 3 ימי תרגול!",
    badge_streak_7: "מסור", badge_streak_7_desc: "רצף של 7 ימי תרגול!",
    badge_nanach: "נ נח", badge_nanach_desc: "סיימת את ההדרכה בהצלחה!",
    tutorial: "הדרכה",
    tutorial_skip: "דלג",
    tutorial_next: "הבא",
    tutorial_prev: "הקודם",
    tutorial_restart: "התחל מחדש",
    tutorial_finish: "מתחילים!",
    tutorial_step1_title: "ברוכים הבאים!",
    tutorial_step1_msg: "בואו נלמד יחד איך משתמשים באפליקציה!",
    tutorial_step2_title: "קריאה",
    tutorial_step2_msg: "לחצו על המילה כדי לסמן אותה כנקראה.<br>לחצו על הרמקול 🔊 כדי לשמוע את המילה.",
    tutorial_step3_title: "דיבור",
    tutorial_step3_msg: "לחצו על המיקרופון 🎤 ואמרו את המילה בקול!<br>האפליקציה תזהה את הדיבור שלכם.",
    tutorial_step4_title: "תרגול",
    tutorial_step4_msg: "בואו נתרגל עם המשפט המיוחד הזה:",
    tutorial_step5_title: "מעולה!",
    tutorial_step5_msg: "עכשיו אתם מוכנים להתחיל את התיקון שלכם!<br>קיבלתם תג חדש!",
  },
  fr: {
    mainTitle: "Tikoun Haklali", completed: "Tu as fini", outOf: "sur 10 psaumes", reset: "Réinitialiser", back: "Retour", selectAll: "Tout valider 🪄", wellDone: "Bravo !", returnMenu: "Retour au menu", finalTitle: "Champion du Tikoun !", finalMsg: "Tu as terminé les 10 psaumes !<br>C'est l'heure de demander ton cadeau à Papa et Maman !", restart: "Recommencer", confirmReset: "Tout recommencer ?", confirmRemove: "Enlever la validation du chapitre ", yes: "Oui", no: "Non",
    ranks: ["Débutant", "Première Étincelle", "Petite Lumière", "Jeune Persévérant", "Détermination", "Mi-chemin !", "Force de Sainteté", "Diffuseur de Lumière", "Presque au bout", "Sommet du Couronnement", "Champion du Tikoun !"],
    micOn: "Micro activé", micOff: "Micro désactivé", micError: "Erreur micro", micNetwork: "Erreur réseau. Reconnexion...",
    points: "Points", streak: "Série", badges: "Badges",
    badge_first_word: "Premier Mot", badge_first_word_desc: "Tu as lu ton premier mot !",
    badge_first_psalm: "Pionnier", badge_first_psalm_desc: "Premier psaume terminé !",
    badge_halfway: "Héros Mi-chemin", badge_halfway_desc: "5 psaumes terminés !",
    badge_tikun_master: "Maître du Tikoun", badge_tikun_master_desc: "Les 10 psaumes terminés !",
    badge_streak_3: "Constant", badge_streak_3_desc: "3 jours de suite !",
    badge_streak_7: "Dévoué", badge_streak_7_desc: "7 jours de suite !",
    badge_nanach: "Na Nach", badge_nanach_desc: "Tu as terminé le tutoriel !",
    tutorial: "Tutoriel",
    tutorial_skip: "Passer",
    tutorial_next: "Suivant",
    tutorial_prev: "Précédent",
    tutorial_restart: "Recommencer",
    tutorial_finish: "C'est parti !",
    tutorial_step1_title: "Bienvenue !",
    tutorial_step1_msg: "Apprenons ensemble comment utiliser l'application !",
    tutorial_step2_title: "Lire",
    tutorial_step2_msg: "Clique sur le mot pour le valider.<br>Clique sur le haut-parleur 🔊 pour l'écouter.",
    tutorial_step3_title: "Parler",
    tutorial_step3_msg: "Clique sur le micro 🎤 et dis le mot à voix haute !<br>L'app reconnaîtra ta voix.",
    tutorial_step4_title: "S'entraîner",
    tutorial_step4_msg: "Entraînons-nous avec cette phrase spéciale :",
    tutorial_step5_title: "Génial !",
    tutorial_step5_msg: "Tu es maintenant prêt à commencer ton Tikoun !<br>Tu as gagné un nouveau badge !",
  },
  en: {
    mainTitle: "Tikoun Haklali", completed: "Completed", outOf: "out of 10 psalms", reset: "Reset", back: "Back", selectAll: "Select All 🪄", wellDone: "Well Done!", returnMenu: "Back to menu", finalTitle: "Tikoun Champion!", finalMsg: "You finished all 10 psalms!<br>Time to get your special prize from Mom and Dad!", restart: "Start Over", confirmReset: "Reset everything?", confirmRemove: "Remove completion for chapter ", yes: "Yes", no: "No",
    ranks: ["Beginner", "First Spark", "Small Light", "Young Perseverant", "Determination", "Halfway!", "Holy Strength", "Light Spreader", "Almost There", "Crown Peak", "Tikoun Champion!"],
    micOn: "Mic On", micOff: "Mic Off", micError: "Mic Error", micNetwork: "Network error. Retrying...",
    points: "Points", streak: "Streak", badges: "Badges",
    badge_first_word: "First Word", badge_first_word_desc: "You read your first word!",
    badge_first_psalm: "Psalm Pioneer", badge_first_psalm_desc: "Completed your first psalm!",
    badge_halfway: "Halfway Hero", badge_halfway_desc: "5 psalms completed!",
    badge_tikun_master: "Tikoun Master", badge_tikun_master_desc: "All 10 psalms completed!",
    badge_streak_3: "Consistent", badge_streak_3_desc: "3-day practice streak!",
    badge_streak_7: "Dedicated", badge_streak_7_desc: "7-day practice streak!",
    badge_nanach: "Na Nach", badge_nanach_desc: "You completed the tutorial!",
    tutorial: "Tutorial",
    tutorial_skip: "Skip",
    tutorial_next: "Next",
    tutorial_prev: "Previous",
    tutorial_restart: "Restart",
    tutorial_finish: "Let's Go!",
    tutorial_step1_title: "Welcome!",
    tutorial_step1_msg: "Let's learn how to use the app together!",
    tutorial_step2_title: "Read",
    tutorial_step2_msg: "Click on the word to check it.<br>Click on the speaker 🔊 to hear it.",
    tutorial_step3_title: "Speak",
    tutorial_step3_msg: "Click on the mic 🎤 and say the word out loud!<br>The app will recognize your voice.",
    tutorial_step4_title: "Practice",
    tutorial_step4_msg: "Let's practice with this special phrase:",
    tutorial_step5_title: "Great!",
    tutorial_step5_msg: "You're now ready to start your Tikun!<br>You earned a new badge!",
  },
  es: {
    mainTitle: "Tikun Haklali", completed: "Completado", outOf: "de 10 salmos", reset: "Reiniciar", back: "Volver", selectAll: "Validar todo 🪄", wellDone: "¡Muy bien!", returnMenu: "Volver al menú", finalTitle: "¡Campeón del Tikun!", finalMsg: "¡Has terminado los 10 salmos!<br>¡Es hora de pedir tu premio a Papá y Mamá!", restart: "Empezar de nuevo", confirmReset: "¿Reiniciar todo?", confirmRemove: "Quitar validación del capítulo ", yes: "Sí", no: "No",
    ranks: ["Principiante", "Primera Chispa", "Pequeña Luz", "Joven Perseverante", "Determinación", "¡Mitad de camino!", "Fuerza Sagrada", "Difusor de Luz", "Casi al final", "Cumbre de la Corona", "¡Campeón del Tikun!"],
    micOn: "Micrófono activado", micOff: "Micrófono desactivado", micError: "Error de micrófono", micNetwork: "Error de red. Reintentando...",
    points: "Puntos", streak: "Racha", badges: "Insignias",
    badge_first_word: "Primera Palabra", badge_first_word_desc: "¡Leíste tu primera palabra!",
    badge_first_psalm: "Pionero del Salmo", badge_first_psalm_desc: "¡Primer salmo completado!",
    badge_halfway: "Héroe Intermedio", badge_halfway_desc: "¡5 salmos completados!",
    badge_tikun_master: "Maestro del Tikun", badge_tikun_master_desc: "¡Los 10 salmos completados!",
    badge_streak_3: "Constante", badge_streak_3_desc: "¡Racha de 3 días!",
    badge_streak_7: "Dedicado", badge_streak_7_desc: "¡Racha de 7 días!",
    badge_nanach: "Na Nach", badge_nanach_desc: "¡Completaste el tutorial!",
    tutorial: "Tutorial",
    tutorial_skip: "Saltar",
    tutorial_next: "Siguiente",
    tutorial_prev: "Anterior",
    tutorial_restart: "Reiniciar",
    tutorial_finish: "¡Listo!",
    tutorial_step1_title: "¡Bienvenido!",
    tutorial_step1_msg: "¡Aprendamos a usar la aplicación juntos!",
    tutorial_step2_title: "Leer",
    tutorial_step2_msg: "Haz clic en la palabra para marcarla.<br>Haz clic en el altavoz 🔊 para escucharla.",
    tutorial_step3_title: "Hablar",
    tutorial_step3_msg: "¡Haz clic en el micro 🎤 y di la palabra en voz alta!<br>La app reconocerá tu voz.",
    tutorial_step4_title: "Práctica",
    tutorial_step4_msg: "Practiquemos con esta frase especial:",
    tutorial_step5_title: "¡Excelente!",
    tutorial_step5_msg: "¡Ya estás listo para comenzar tu Tikún!<br>¡Ganaste una nueva insignia!",
  }
};

const emojiRanks = ["🕯️", "✨", "💡", "🪵", "🔥", "🛡️", "⚡", "🌟", "💎", "👑", "🏆"];
const psalmList = [16, 32, 41, 42, 59, 77, 90, 105, 137, 150];

const psalmsData: Record<number, string> = {
  16: "מִכְתָּם לְדָוִד שָׁמְרֵנִי אֵל כִּי חָסִיתִי בָךְ: אָמַרְתְּ לַיהֹוָה אֲדֹנָי אָתָּה טוֹבָתִי בַּל עָלֶיךָ: לִקְדוֹשִׁים אֲשֶׁר בָּאָרֶץ הֵמָּה וְאַדִּירֵי כָּל חֶפְצִי בָם: יִרְבּוּ עַצְּבוֹתָם אַחֵר מָהָרוּ בַּל אַסִּיךְ נִסְכֵּיהֶם מִדָּם וּבַל אֶשָּׂא אֶת שְׁמוֹתָם עַל שְׂפָתָי: יְהֹוָה מְנָת חֶלְקִי וְכוֹסִי אַתָּה תּוֹמִיךְ גּוֹרָלִי: חֲבָלִים נָפְלוּ לִי בַּנְּעִמִים אַף נַחֲלָת שָׁפְרָה עָלָי: אֲבָרֵךְ אֶת יְהֹוָה אֲשֶׁר יְעָצָנִי אַף לֵילוֹת יִסְּרוּנִי כִלְיוֹתָי: שִׁוִּיתִי יְהֹוָה לְנֶגְדִּי תָמִיד כִּי מִימִינִי בַּל אֶמּוֹט: לָכֵן שָׂמַח לִבִּי וַיָּגֶל כְּבוֹדִי אַף בְּשָׂרִי יִשְׁכֹּן לָבֶטַח: כִּי לֹא תַעֲזֹב נַפְשִׁי לִשְׁאוֹל לֹא תִתֵּן חֲסִידְךָ לִרְאוֹת שָׁחַת: תּוֹדִיעֵנִי אֹרַח חַיִּים שֹׂבַע שְׂמָחוֹת אֶת פָּנֶיךָ נְעִמוֹת בִּימִינְךָ נֶצַח:",
  32: "לְדָוִד מַשְׂכִּיל אַשְׁרֵי נְשׂוּי פֶּשַׁע כְּסוּי חֲטָאָה: אַשְׁרֵי אָדָם לֹא יַחְשֹׁב יְהֹוָה לוֹ עָו‍ֹן וְאֵין בְּרוּחוֹ רְמִיָּה: כִּי הֶחֱרַשְׁתִּי בָּלוּ עֲצָמָי בְּשַׁאֲגָתִי כָּל הַיּוֹם: כִּי יוֹמָם וָלַיְלָה תִּכבַּד עָלַי יָדֶךָ נֶהְפַּךְ לְשַׁדִּי בְּחַרְבֹנֵי קַיִץ סֶלָה: חַטָּאתִי אוֹדִיעֲךָ וַעֲו‍ֹנִי לֹא כִסִּיתִי אָמַרְתִּי אוֹדֶה עֲלֵי פְשָׁעַי לַיהֹוָה וְאַתָּה נָשָׂאתָ עֲו‍ֹן חַטָּאתִי סֶלָה: עַל זֹאת יִתְפַּלֵּל כָּל חָסִיד אֵלֶיךָ לְעֵת מְצֹא רַק לְשֵׁטֶף מַיִם רַבִּים אֵלָיו לֹא יַגִּיעוּ: אַתָּה סֵתֶר לִי מִצַּר תִּצְּרֵנִי רָנֵּי פַלֵּט תְּסוֹבְבֵנִי סֶלָה: אַשְׂכִּילְךָ וְאוֹרְךָ בְּדֶרֶךְ זוּ תֵלֵךְ אִיעֲצָה עָלֶיךָ עֵינִי: אַל תִּהְיוּ כְּסווס כְּפֶרד אֵין הָבִין בְּמֶתֶג וָרֶסֶן עֶדְיוֹ לִבלוֹם בַּל קְרֹב אֵלֶיךָ: רַבִּים מַכְאוֹבִים לָרָשָׁע וְהַבוֹטֵחַ בַּיהֹוָה חֶסֶד יְסוֹבְבֶנּוּ: שִׂמְחוּ בַיהֹוָה וְגִילוּ צַדִּיקִים וְהַרנִינוּ כָּל יִשְׁרֵי לֵב:",
  41: "לַמְנַצֵּחַ מִזְמוֹר לְדָוִד: אַשְׁרֵי מַשְׂכִּיל אֶל דָּל בְּיוֹם רָעָה יְמַלְּטֵהוּ יְהֹוָה: יְהֹוָה יִשְׁמְרֵהוּ וִיחַיֵּהוּ יְאֻשַּׁר בָּאָרֶץ וְאַל תִּתְּנֵהוּ בְּנֶפֶשׁ אֹיְבָיו: יְהֹוָה יִסְעָדֶנּוּ עַל עֶרֶשׂ דְּוָי כָּל מִשְׁכָּבוֹ הָפַכְתָּ בְחָלְיוֹ: אֲנִי אָמַרְתִּי יְהֹוָה חָנֵּנִי רְפָאָה נַפְשִׁי כִּי חָטָאתִי לָךְ: אוֹיְבַי יֹאמְרוּ רַע לִי מָתַי יָמוּת וְאָבַד שְׁמוֹ: וְאִם בָּא לִרְאוֹת שָׁוְא יְדַבֵּר לִבּוֹ יִקְבָּץ אָוֶן לוֹ יֵצֵא לַחוּץ יְדַבֵּר: יַחַד עָלַי יִתְלַחֲשׁוּ כָּל שֹׂנְאָי עָלַי יַחְשְׁבוּ רָעָה לִי: דְּבַר בְּלִיַּעַל יָצוּק בּוֹ וַאֲשֶׁר שָׁכַב לֹא יוֹסִיף לָקוּם: גַּם אִישׁ שְׁלוֹמִי אֲשֶׁר בָּטַחְתִּי בוֹ אוֹכֵל לַחְמִי הִגְדִּיל עָלַי עָקֵב: וְאַתָּה יְהֹוָה חָנֵּנִי וַהֲקִימֵנִי וַאֲשַׁלְּמָה לָהֶם: בְּזֹאת יָדַעְתִּי כִּי חָפַצְתָּ בִּי כִּי לֹא יָרִיעַ אֹיְבִי עָלָי: וַאֲנִי בְּתֻמִּי תָּמַכְתָּ בִּי וַתַּצִּיבֵנִי לְפָנֶיךָ לְעוֹלָם: בָּרוּךְ יְהֹוָה אֱלֹהֵי יִשְׂרָאֵל מֵהָעוֹלָם וְעַד הָעוֹלָם אָמֵן וְאָמֵן:",
  42: "לַמְנַצֵּחַ מַשְׂכִּיל לִבְנֵי קֹרַח: כְּאַיָּל תַּעֲרֹג עַל אֲפִיקֵי מָיִם כֵּן נַפְשִׁי תַעֲרֹג אֵלֶיךָ אֱלֹהִים: צָמְאָה נַפְשִׁי לֵאלֹהִים לְאֵל חָי מָתַי אָבוֹא וְאֵרָאֶה פְּנֵי אֱלֹהִים: הָיְתָה לִּי דִמְעָתִי לֶחֶם יוֹמָם וָלָיְלָה בֶּאֱמֹר אֵלַי כָּל הַיּוֹם אַיֵּה אֱלֹהֶיךָ: אֵלֶּה אֶזְכְּרָה וְאֶשְׁפְּכָה עָלַי נַפְשִׁי כִּי אֶעֱבֹר בַּסָּךְ אֶדַּדֵּם עַד בֵּית אֱלֹהִים בְּקוֹל רִנָּה וְתוֹדָה הָמוֹן חוֹגֵג: מַה תִּשְׁתּוֹחֲחִי נַפְשִׁי וַתֶּהֱמִי עָלָי הוֹחִילִי לֵאלֹהִים כִּי עוֹד אוֹדֶנּוּ יְשׁוּעוֹת פָּנָיו: אֱלֹהַי עָלַי נַפְשִׁי תִשְׁתּוֹחָח עַל כֵּן אֶזְכָּרְךָ מֵאֶרֶץ יַרְדֵּן וְחֶרְמוֹנִים מֵהַר מִצְעָר: תְּהוֹם אֶל תְּהוֹם קוֹרֵא לְקוֹל צִנּוֹרֶיךָ כָּל מִשְׁבָּרֶיךָ וְגַלֶּיךָ עָלַי עָבָרוּ: יוֹמָם יְצַוֶּה יְהֹוָה חַסְדּוֹ וּבַלַּיְלָה שִׁירוֹ עִמִּי תְּפִלָּה לְאֵל חַיָּי: אוֹמְרָה לְאֵל סַלְעִי לָמָה שְׁכַחְתָּנִי לָמָּה קֹדֵר אֵלֵךְ בְּלַחַץ אוֹיֵב: בְּרֶצַח בְּעַצְמוֹתַי חֵרְפוּנִי צוֹרְרָי בֶּאֱמֹרָם אֵלַי כָּל הַיּוֹם אַיֵּה אֱלֹהֶיךָ: מַה תִּשְׁתּוֹחֲחִי נַפְשִׁי וּמַה תֶּהֱמִי עָלָי הוֹחִילִי לֵאלֹהִים כִּי עוֹד אוֹדֶנּוּ יְשׁוּעֹת פָּנַי וֵאלֹהָי:",
  59: "לַמְנַצֵּחַ אַל תַּשְׁחֵת לְדָוִד מִכְתָּם בִּשְׁלֹחַ שָׁאוּל וַיִּשְׁמְרוּ אֶת הַבַּיִת לַהֲמיתוֹ: הַצִּילֵנִי מֵאֹיְבַי אֱלֹהָי מִמִּתְקוֹמְמַי תְּשַׂגְּבֵנִי: הַצִּילֵנִי מִפֹּעֲלֵי אָוֶן וּמֵאַנְשֵׁי דָמִים הוֹשִׁיעֵנִי: כִּי הִנֵּה אָרְבוּ לְנַפְשִׁי יָגוּרוּ עָלַי עַזִּים לֹא פִשְׁעִי וְלֹא חַטָּאתִי יְהֹוָה: בְּלִי עָוֹן יְרוּצוּן וְיִכּוֹנָנוּ עוּרָה לִקְרָאתִי וּרְאֵה: וְאַתָּה יְהֹוָה אֱלֹהִים צְבָאוֹת אֱלֹהֵי יִשְׂרָאֵל הָקִיצָה לִפְקֹד כָּל הַגּוֹיִם אַל תָּחֹן כָּל בֹּגְדֵי אָוֶן סֶלָה: יָשׁוּבוּ לָעֶרֶב יֶהֱמוּ כַכָּלֶב וִיסוֹבְבוּ עִיר: הִנֵּה יַבִּיעוּן בְּפִיהֶם חֲרָבוֹת בְּשִׂפְתוֹתֵיהֶם כִּי מִי שֹׁמֵעַ: וְאַתָּה יְהֹוָה תִּשְׂחַק לָמוֹ תִּלְעַג לְכָל גּוֹיִם: עֻזּוֹ אֵלֶיךָ אֶשְׁמֹרָה כִּי אֱלֹהִים מִשְׂגַּבִּי: אֱלֹהֵי חַסְדִּי יְקַדְּמֵנִי אֱלֹהִים יַרְאֵנִי בְשׁוֹרְרָי: אַל תַּהַרְגֵם פֶּן יִשְׁכְּחוּ עַמִּי הֲנִיעֵמוֹ בְחֵילְךָ וְהוֹרִידֵמוֹ מָגִנֵּנוּ אֲדֹנָי: חַטַּאת פִּיהֶם דְּבַר שְׂפָתֵימוֹ וְיִלָּכְדוּ בִגְאוֹנָם וּמֵאָלָה וּמִכַּחַשׁ יְסַפֵּרוּ: כַּלֵּה בְחֵמָה כַּלֵּה וְאֵינֵמוֹ וְיֵדְעוּ כִּי אֱלֹהִים מֹשֵׁל בְּיַעֲקֹב לְאַפְסֵי הָאָרֶץ סֶלָה: וְיָשׁוּבוּ לָעֶרֶב יֶהֱמוּ כַכָּלֶב וִיסוֹבְבוּ עִיר: הֵמָּה ינִיעוּן לֶאֱכֹל אִם לֹא יִשְׂבְּעוּ וַיָּלִינוּ: וַאֲנִי אָשִׁיר עֻזֶּךָ וַאֲרַנֵּן לַבֹּקֶר חַסְדֶּךָ כִּי הָיִיתָ מִשְׂגָּב לִי וּמָנוֹס בְּיוֹם צַר לִי: עֻזִּי אֵלֶיךָ אֲזַמֵּרָה כִּי אֱלֹהִים מִשְׂגַּבִּי אֱלֹהֵי חַסְדִּי:",
  77: "לַמְנַצֵּחַ עַל יְדוּתוּן לְאָסָף מִזְמוֹר: קוֹלִי אֶל אֱלֹהִים וְאֶצְעָקָה קוֹלִי אֶל אֱלֹהִים וְהַאֲזִין אֵלָי: בְּיוֹם צָרָתִי אֲדֹנָי דָּרָשְׁתִּי יָדִי לַיְלָה נִגְרָה וְלֹא תָפוּג מֵאֲנָה הִנָּחֵם נַפְשִׁי: אֶזְכְּרָה אֱלֹהִים וְאֶהֱמָיָה אָשִׂיחָה וְתִתְעַטֵּף רוּחִי סֶלָה: אָחַזְתָּ שְׁמֻרוֹת עֵינָי נִפְעַמְתִּי וְלֹא אֲדַבֵּר: חִשַּׁבְתִּי יָמִים מִקֶּדֶם שְׁנוֹת עוֹלָמִים: אֶזְכְּרָה נְגִינָתִי בַּלָּיְלָה עִם לְבָבִי אָשִׂיחָה וַיְחַפֵּשׂ רוּחִי: הַלְעוֹלָמִים יִזְנַח אֲדֹנָי וְלֹא יֹסִיף לִרְצוֹת עוֹד: הֶאָפֵס לָנֶצַח חַסְדּוֹ גָּמַר אֹמֶר לְדֹר וָדֹר: הֲשָׁכַח חַנּוֹת אֵל אִם קָפַץ בְּאַף רַחֲמָיו סֶלָה: וָאֹמַר חַלּוֹתִי הִיא שְׁנוֹת יְמִין עֶלְיוֹן: אֶזְכּוֹר מַעַלְלֵי יָהּ כִּי אֶזְכְּרָה מִקֶּדֶם פִּלְאֶךָ: וְהָגיתִי בְכָל פָּעֳלֶךָ וּבַעֲלילוֹתֶיךָ אָשִׂיחָה: אֱלֹהִים בַּקֹּדֶשׁ דַּרְכֶּךָ מִי אֵל גָּדוֹל כֵּאלֹהִים: אַתָּה הָאֵל עֹשֵׂה פֶלֶא הוֹדַעְתָּ בָעַמִּים עֻזֶּךָ: גָּאַלְתָּ בִּזרוֹעַ עַמֶּךָ בְּנֵי יַעֲקֹב וְיוֹסֵף סֶלָה: רָאוּךָ מַּיִם אֱלֹהִים רָאוּךָ מַּיִם יָחִילוּ אַף יִרְגְּזוּ תְהֹמוֹת: זֹרְמוּ מַיִם עָבוֹת קוֹל נָתְנוּ שְׁחָקִים אַף חֲצָצֶיךָ יִתְהַלָּכוּ: קוֹל רַעַמְךָ בַּגַּלְגּל הֵאִירוּ בְרָקִים תֵּבֵל רָגְזָה וַתִּרְעַשׁ הָאָרֶץ: בַּיָּם דַּרְכֶּךָ וּשְׁבִילְךָ בְּמַיִם רַבִּים וְעִקְּבוֹתֶיךָ לֹא נוֹדָעוּ: נָחִיתָ כַצֹּאן עַמֶּךָ בְּיַד מֹשֶׁה וְאַהֲרֹן",
  90: "תְּפִלָּה לְמֹשֶׁה אִישׁ הָאֱלֹהִים אֲדֹנָי מָעוֹן אַתָּה הָיִיתָ לָּנוּ בְּדֹר וָדֹר: בְּטֶרֶם הָרִים יֻלָּדוּ וַתְּחוֹלֵל אֶרֶץ וְתֵבֵל וּמֵעוֹלָם עַד עוֹלָם אַתָּה אֵל: תָּשֵׁב אֱנוֹשׁ עַד דַּכָּא וַתֹּאמר שׁוּבוּ בְנֵי אָדָם: כִּי אֶלֶף שָׁנִים בְּעֵינֶיךָ כְּיוֹם אֶתְמוֹל כִּי יַעֲבֹר וְאַשְׁמוּרה בַלָּיְלָה: זְרַמְתָּם שֵׁנָה יִהְיוּ בַּבֹּקקר כֶּחָצִיר יַחֲלֹף: בַּבֹּקֶר יָצִיץ וְחָלָף לָעֶרֶב יְמוֹלֵל וְיָבֵשׁ: כִּי כָלִינוּ בְאַפֶּךָ וּבַחֲמָתְךָ נִבְהָלְנוּ: שַׁתָּה עֲוֹנֹתֵינוּ לְנֶגְדֶּךָ עֲלֻמֵנוּ לִמְאוֹר פָּנֶיךָ: כִּי כָל יָמֵינוּ פָּנוּ בְעֶבְרָתֶךָ כִּלִּינוּ שָׁנֵינוּ כְמוֹ הֶגֶה: יְמֵי שְׁנוֹתֵינוּ בָהֶם שִׁבְעִים שָׁנָה וְאִם בִּגְבוּרֹת שְׁמוֹנִים שָׁנָה וְרָהְבָּם עָמָל וָאָוֶן כִּי גָז חִישׁ וַנָּעֻפָה: מִי יוֹדֵעַ עֹז אַפֶּךָ וּכְיִרְאָתְךָ עֶבְרָתֶךָ: לִמְנוֹת יָמֵינוּ כֵּן הוֹדַע וְנָבִא לְבָבָב חָכְמָה: שׁוּבָה יְהֹוָה עַד מָתָי וְהִנָּחֵם עַל עֲבָדֶיךָ: שַׂבְּעֵנוּ בַבֹּקֶר חַסְדֶּךָ וּנְרַנְּנָה וְנִשְׂמְחָה בְּכָל יָמֵינוּ: שַׂמְּחֵנוּ כִּימוֹת עִנִּיתָנוּ שְׁנוֹת רָאִינוּ רָעָה: יֵרָאֶה אֶל עֲבָדֶיךָ פָעֳלֶךָ וַהֲדָרְךָ עַל בְּנֵיהֶם: וִיהִי נֹעַם אֲדֹנָי אֱלֹהֵינוּ עָלֵינוּ וּמַעֲשֵׂה יָדֵינוּ כּוֹנְנָה עָלֵינוּ וּמַעֲשֵׂה יָדֵינוּ כּוֹנְנֵהוּ:",
  105: "הוֹדוּ לַיהֹוָה קִרְאוּ בִשְׁמוֹ הוֹדִיעוּ בָעַמִּים עֲלִילוֹתָיו: שִׁירוּ לוֹ זַמְּרוּ לוֹ שִׂיחוּ בְּכָל נִפְלְאוֹתָיו: הִתְהַלְלוּ בְּשֵׁם קָדְשׁוֹ יִשְׂמַח לֵב מְבַקְשֵׁי יְהֹוָה: דִּרְשׁוּ יְהֹוָה וְעֻזּוֹ בַּקְּשׁוּ פָנָיו תָּמִיד: זִכְרוּ נִפְלְאוֹתָיו אֲשֶׁר עָשָׂה מֹפְתָיו וּמִשְׁפְּטֵי פִיו: זֶרַע אַבְרָהָם עַבְדּוֹ בְּנֵי יַעֲקֹב בְּחִירָיו: הוּא יְהֹוָה אֱלֹהֵינוּ בְּכָל הָאָרֶץ מִשְׁפָּטָיו: זָכַר לְעוֹלָם בְּרִיתוֹ דָּבָר צִוָּה לְאֶלֶף דּוֹר: אֲשֶׁר כָּרַת אֶת אַבְרָהָם וּשְׁבוּעָתוֹ לְיִשְׂחָק: וַיַּעֲמִידֶהָ לְיַעֲקֹב לְחֹק לְיִשְׂרָאֵל בְּרִית עוֹלָם: לֵאמֹר לְךָ אֶתֵּן אֶת אֶרֶץ כְּנָעַן חֶבֶל נַחֲלַתְכֶם: בִּהְיוֹתָם מְתֵי מִסְפָּר כִּמְעַט וְגָרִים בָּהּ: וַיִּתְהַלְּכוּ מִגּוֹי אֶל גּוֹי מִמַּמְלָכָה אֶל עַם אַחֵר: לֹא הִנִּיחַ אָדָם לְעָשְׁקָם וַיּוֹכַח עֲלֵיהֶם מְלָכִים: אַל תִּגְּעוּ בִמְשִׁיחָי וְלִנְבִיאַי אַל תָּרֵעוּ: וַיִּקְרָא רָעָב עַל הָאָרֶץ כָּל מַטֵּה לֶחֶם שָׁבָר: שָׁלַח לִפְנֵיהֶם אִישׁ לְעֶבד נִמְכַּר יוֹסֵף: עִנּוּ בַכֶּבֶל רַגלוֹ בַּרְזֶל בָּאָה נַפְשׁוֹ: עַד עֵת בֹּא דְבָרוֹ אִמְרַת יְהֹוָה צְרָפָתְהוּ: שָׁלַח מֶלֶך וַיַּתִּירֵהוּ מֹשֵׁל עַמִּים וַיְפַתְּחֵהוּ: שָׂמוֹ אָדוֹן לְבֵיתוֹ וּמֹשֵׁל בְּכָל קִנְיָנוֹ: לֶאְסֹר שָׂרָיו בְּנַפְשׁוֹ וּזְקֵנָיו יְחַכֵּם: וַיָּבֹא יִשְׂרָאֵל מִצְרָיִם וְיַעֲקֹב גָּר בְּאֶרֶץ חָם: וַיֶּפֶר אֶת עַמּוֹ מְאֹד וַיַּעֲצִמֵהוּ מִצָּרָיו: הָפַךְ לִבָּם לִשְׂנֹא עַמּוֹ לְהִתְנַכֵּל בַּעֲבָדָיו: שָׁלַח מֹשֶׁה עַבְדּוֹ אַהֲרֹן אֲשֶׁר בָּחַר בּוֹ: שָׂמוּ בָם דִּבְרֵי אֹתוֹתָיו וּמֹפְתִים בְּאֶרֶץ חָם: שָׁלַח חֹשֶׁךְ וַיַּחְשִׁךְ וְלֹא מָרוּ אֶת דְּבָרוֹ: הָפַךְ אֶת מֵימֵיהֶם לְדָם וַיָּמֶת אֶת דְּגָתָם: שָׁרַץ אַרְצָם צְפַרְדְּעִים בְּחַדְרֵי מַלְכֵיהֶם: אָמַר וַיָּבֹא עָרֹב כִּנִּים בְּכָל גְּבוּלָם: נָתַן גִּשְׁמֵיהֶם בָּרָד אֵשׁ לֶהָבוֹת בְּאַרְצָם: וַיַּךְ גַּפנָם וּתְאֵנָתָם וַיְשַׁבֵּר עֵץ גְּבוּלָם: אָמַר וַיָּבֹא אַרְבֶּה וְיֶלֶק וְאֵין מִסְפָּר: וַיֹּאכַל כָּל עֵשֶׂב בְּאַרְצָם וַיֹּאכַל פְּרִי אַדְמָתָם: וַיַּךְ כָּל בְּכוֹר בְּאַרְצָם רֵאשִׁית לְכָל אוֹנָם: וַיּוֹצִיאֵם בְּכֶסֶף וְזָהָב וְאֵין בִּשְׁבָטָיו כּוֹשֵׁל: שָׂמַח מִצרַיִם בְּצֵאתָם כִּי נָפַל פַּחְדָּם עֲלֵיהֶם: פָּרַשׂ עָנָן לְמָסָךְ וְאֵשׁ לְהָאִיר לָיְלָה: שָׁאַל וַיָּבֵא שְׂלָו וְלֶחֶם שָׁמַיִם יַשְׂבִּיעֵם: פָּתַח צוּר וַיָּזוּבוּ מָיִם הָלְכוּ בַּצִּיּוֹת נָהָר: כִּי זָכַר אֶת דְּבַר קָדְשׁוֹ אֶת אַבְרָהָם עַבְדּוֹ: וַיּוֹצִא עַמּוֹ בְשָׂשׂוֹן בְּרִנָּה אֶת בְּחִירָיו: וַיִּתֵּן לָהֶם אַרְצוֹת גּוֹיִם וַעֲמַל לְאֻמִּים יִירָשׁוּ: בַּעֲבוּר יִשְׁמְרוּ חֻקָּיו וְתוֹרֹתָיו יִנְצֹרוּ הַלְלוּיָהּ:",
  137: "עַל נַהֲרוֹת בָּבֶל שָׁם יָשַׁבְנוּ גַּם בָּכִינוּ בְּזָכְרֵנוּ אֶת צִיּוֹן: עַל עֲרָבִים בְּתוֹכָהּ תָּלִינוּ כִּנֹּרוֹתֵינוּ: כִּי שָׁם שְׁאֵלוּנוּ שׁוֹבֵינוּ דִּבְרֵי שִׁיר וְתוֹלָלֵינוּ שִׂמְחָה שִׁירוּ לָנוּ מִשִּׁיר צִיּוֹן: אֵיךְ נָשִׁיר אֶת שִׁיר יְהֹוָה עַל אַדְמַת נֵכָר: אִם אֶשְׁכָּחֵךְ יְרוּשָׁלִָם תִּשְׁכַּח יְמִינִי: תִּדְבַּק לְשׁוֹנִי לְחִכִּי אִם לֹא אֶזְכְּרֵכִי אִם לֹא אַעֲלֶה אֶת יְרוּשָׁלִַם עַל רֹאשׁ שִׂמְחָתִי: זְכֹר יְהֹוָה לִבְנֵי אֱדוֹם אֵת יוֹם יְרוּשָׁלִָם הָאֹמְרִים עָרוּ עָרוּ עַד הַיְסוֹד בָּהּ: בַּת בָּבֶל הַשְּׁדוּדָה אַשְׁרֵי שֶׁיְשַׁלֶּם לָךְ אֶת גְּמוּלֵךְ שֶׁגָּמַלְתְּ לָנוּ: אַשְׁרֵי שֶׁיֹּאחֵז וְנִפֵּץ אֶת עֹלָלַיִךְ אֶל הַסָּלַע:",
  150: "הַלְלוּיָהּ הַלְלוּ אֵל בְּקָדְשׁוֹ הַלְלוּהוּ בִּרְקִיעַ עֻזּוֹ: הַלְלוּהוּ בִּגְבוּרֹתָיו הַלְלוּהוּ כְּרֹב גֻּדְלוֹ: הַלְלוּהוּ בְּתֵקַע שׁוֹפָר הַלְלוּהוּ בְּנֵבֶל וְכִנּוֹר: הַלְלוּהוּ בְּתֹף וּמָחוֹל הַלְלוּהוּ בְּמִנִּים וְעֻגָב: הַלְלוּהוּ בְּצִלְצְלֵי שָׁמַע הַלְלוּהוּ בְּצִלְצְלֵי תְרוּעָה: כֹּל הַנְּשָׁמָה תְּהַלֵּל יָהּ הַלְלוּיָהּ:"
};

export default function App() {
  const [lang, setLang] = useState<string>(() => localStorage.getItem('tikun_lang') || 'he');
  const [completed, setCompleted] = useState<number[]>(() => JSON.parse(localStorage.getItem('tikun_c') || "[]"));
  const [points, setPoints] = useState<number>(() => Number(localStorage.getItem('tikun_pts') || "0"));
  const [streak, setStreak] = useState<number>(() => Number(localStorage.getItem('tikun_strk') || "0"));
  const [lastPracticeDate, setLastPracticeDate] = useState<string | null>(() => localStorage.getItem('tikun_last_date'));
  const [badges, setBadges] = useState<string[]>(() => JSON.parse(localStorage.getItem('tikun_badges') || "[]"));
  const [newBadge, setNewBadge] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState<number | null>(null);
  const [showTutorial, setShowTutorial] = useState<boolean>(() => localStorage.getItem('tikun_tutorial_seen') !== 'true');
  
  const [currentP, setCurrentP] = useState<number | null>(null);
  const [activeWords, setActiveWords] = useState<Set<number>>(new Set());
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => localStorage.getItem('tikun_dark') === 'true');
  
  // Confirmation state
  const [confirmData, setConfirmData] = useState<{ type: 'reset' | 'remove', psalm?: number } | null>(null);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [micError, setMicError] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);
  const nextWordIndexRef = useRef<number>(-1);
  const currentPsalmWordsRef = useRef<string[]>([]);
  const lastProcessedWordCountRef = useRef<number>(0);
  const lastProcessedResultIndexRef = useRef<number>(-1);

  const t = i18n[lang];

  const currentPsalmWords = useMemo(() => {
    if (currentP === null) return [];
    return psalmsData[currentP].split(' ');
  }, [currentP]);

  const nextWordIndex = useMemo(() => {
    for (let i = 0; i < currentPsalmWords.length; i++) {
      if (!activeWords.has(i)) return i;
    }
    return -1;
  }, [currentPsalmWords, activeWords]);

  useEffect(() => {
    nextWordIndexRef.current = nextWordIndex;
    currentPsalmWordsRef.current = currentPsalmWords;
  }, [nextWordIndex, currentPsalmWords]);

  const handleAwardBadge = useCallback((badgeId: string) => {
    setBadges(prev => {
      if (prev.includes(badgeId)) return prev;
      setNewBadge(badgeId);
      // Auto-dismiss badge notification after 5 seconds
      setTimeout(() => setNewBadge(null), 5000);
      return [...prev, badgeId];
    });
  }, []);

  const handlePracticeAction = useCallback(() => {
    const today = new Date().toISOString().split('T')[0];
    if (lastPracticeDate === today) return;

    const lastDate = lastPracticeDate ? new Date(lastPracticeDate) : null;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    if (lastPracticeDate === yesterdayStr) {
      setStreak(prev => {
        const next = prev + 1;
        if (next === 3) handleAwardBadge('streak_3');
        if (next === 7) handleAwardBadge('streak_7');
        return next;
      });
    } else if (lastPracticeDate !== today) {
      setStreak(1);
    }
    setLastPracticeDate(today);
  }, [lastPracticeDate, handleAwardBadge]);

  const handleCompletePsalm = useCallback((n: number) => {
    setCompleted(prev => {
      if (!prev.includes(n)) {
        const next = [...prev, n];
        if (next.length === 1) handleAwardBadge('first_psalm');
        if (next.length === 5) handleAwardBadge('halfway');
        if (next.length === 10) handleAwardBadge('tikun_master');
        return next;
      }
      return prev;
    });
    setPoints(prev => prev + 50);
    confetti({
      particleCount: 150,
      spread: 70,
      origin: { y: 0.6 }
    });
  }, [handleAwardBadge]);

  const handleToggleWord = useCallback((index: number, isFromMic = false) => {
    setActiveWords(prev => {
      const newActive = new Set(prev);
      if (newActive.has(index)) {
        newActive.delete(index);
      } else {
        newActive.add(index);
        if (isFromMic) {
          setPoints(p => p + 1);
          handlePracticeAction();
          handleAwardBadge('first_word');
        }
      }
      return newActive;
    });
  }, [handlePracticeAction, handleAwardBadge]);

  const speakWord = useCallback((word: string, index: number) => {
    if (isSpeaking !== null || !word) return;
    
    // Use native browser Speech Synthesis for basic pronunciation
    if (!('speechSynthesis' in window)) {
      console.error('Speech synthesis not supported in this browser');
      return;
    }

    setIsSpeaking(index);
    
    // Stop any current speech
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = 'he-IL'; // Hebrew
    utterance.rate = 0.85; // Slightly slower for clarity
    utterance.pitch = 0.8; // Deeper, more masculine tone
    
    // Try to find a male Hebrew voice if available
    const voices = window.speechSynthesis.getVoices();
    const hebrewVoices = voices.filter(v => v.lang.startsWith('he'));
    const maleVoice = hebrewVoices.find(v => 
      v.name.toLowerCase().includes('david') || 
      v.name.toLowerCase().includes('asaf') || 
      v.name.toLowerCase().includes('male')
    );
    
    if (maleVoice) {
      utterance.voice = maleVoice;
    } else if (hebrewVoices.length > 0) {
      utterance.voice = hebrewVoices[0];
    }
    
    utterance.onend = () => {
      setIsSpeaking(null);
    };

    utterance.onerror = (event) => {
      console.error('Speech synthesis error', event);
      setIsSpeaking(null);
    };

    window.speechSynthesis.speak(utterance);
  }, [isSpeaking]);

  // Check for completion when activeWords changes
  useEffect(() => {
    if (currentP !== null && activeWords.size === currentPsalmWords.length && currentPsalmWords.length > 0) {
      handleCompletePsalm(currentP);
    }
  }, [activeWords, currentP, currentPsalmWords.length, handleCompletePsalm]);

  useEffect(() => {
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'he-IL';

    recognition.onresult = (event: any) => {
      const lastResultIndex = event.results.length - 1;
      const result = event.results[lastResultIndex];
      const transcript = result[0].transcript.trim();
      const words = transcript.split(/\s+/);
      
      // Determine which words in the current result are new
      let startIndex = 0;
      if (lastResultIndex === lastProcessedResultIndexRef.current) {
        startIndex = lastProcessedWordCountRef.current;
      }

      // Use a local variable to track target progression within this single result update
      // This ensures each spoken word only matches ONE target word
      let currentTargetIndex = nextWordIndexRef.current;

      const isMatch = (s: string, t: string) => {
        if (!s || !t) return false;
        if (s === t) return true;
        // Inclusion check for words of reasonable length
        if (s.length >= 3 && t.length >= 3) {
          if (s.includes(t) || t.includes(s)) return true;
          // Fuzzy match: 1 character difference for longer words
          if (s.length >= 4 && t.length >= 4) {
            let diffs = 0;
            const minL = Math.min(s.length, t.length);
            for (let k = 0; k < minL; k++) if (s[k] !== t[k]) diffs++;
            diffs += Math.abs(s.length - t.length);
            if (diffs <= 1) return true;
          }
        }
        return false;
      };

      for (let i = startIndex; i < words.length; i++) {
        const spokenWord = words[i];
        if (currentTargetIndex !== -1 && currentTargetIndex < currentPsalmWordsRef.current.length) {
          const targetWord = currentPsalmWordsRef.current[currentTargetIndex];
          const normTarget = normalizeHebrewForSpeech(targetWord);
          const normSpoken = normalizeHebrewForSpeech(spokenWord);

          if (isMatch(normSpoken, normTarget)) {
            handleToggleWord(currentTargetIndex, true);
            currentTargetIndex++; // Advance to the next target word
            continue;
          }

          // Contextual Lookahead: If the spoken word matches the NEXT target word, 
          // we assume the current one was skipped or mispronounced and validate both.
          if (currentTargetIndex + 1 < currentPsalmWordsRef.current.length) {
            const nextTargetWord = currentPsalmWordsRef.current[currentTargetIndex + 1];
            const normNextTarget = normalizeHebrewForSpeech(nextTargetWord);
            if (isMatch(normSpoken, normNextTarget)) {
              handleToggleWord(currentTargetIndex, true);
              handleToggleWord(currentTargetIndex + 1, true);
              currentTargetIndex += 2;
              continue;
            }
          }
        }
      }
      
      // Update refs to mark these words as processed
      lastProcessedResultIndexRef.current = lastResultIndex;
      lastProcessedWordCountRef.current = words.length;
    };

    recognition.onstart = () => {
      setMicError(null);
    };

    recognition.onerror = (event: any) => {
      if (event.error === 'no-speech') {
        // Ignore no-speech error to avoid annoying the user
        return;
      }
      console.error('Speech recognition error', event.error);
      if (event.error === 'not-allowed') {
        setMicError(t.micError);
        setIsListening(false);
      } else if (event.error === 'network') {
        setMicError(t.micNetwork);
      } else {
        setMicError(`${t.micError}: ${event.error}`);
      }
    };

    recognition.onend = () => {
      // If we're still supposed to be listening, restart after a short delay
      // This handles both normal ends and error-induced ends (like network errors)
      if (recognitionRef.current && isListening) {
        setTimeout(() => {
          if (isListening && recognitionRef.current) {
            try {
              recognitionRef.current.start();
            } catch (e) {
              // If it's already started, this will throw, which is fine
              console.warn('Recognition restart attempt', e);
            }
          }
        }, 1000);
      }
    };

    recognitionRef.current = recognition;

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, [handleToggleWord, isListening]);

  useEffect(() => {
    if (!recognitionRef.current) return;
    if (isListening) {
      try {
        recognitionRef.current.start();
        setMicError(null);
      } catch (e) {
        console.error('Start error', e);
      }
    } else {
      recognitionRef.current.stop();
    }
  }, [isListening]);

  useEffect(() => {
    localStorage.setItem('tikun_lang', lang);
    document.body.dir = lang === 'he' ? 'rtl' : 'ltr';
  }, [lang]);

  useEffect(() => {
    localStorage.setItem('tikun_c', JSON.stringify(completed));
  }, [completed]);

  useEffect(() => {
    localStorage.setItem('tikun_pts', String(points));
  }, [points]);

  useEffect(() => {
    localStorage.setItem('tikun_strk', String(streak));
  }, [streak]);

  useEffect(() => {
    if (lastPracticeDate) localStorage.setItem('tikun_last_date', lastPracticeDate);
  }, [lastPracticeDate]);

  useEffect(() => {
    localStorage.setItem('tikun_badges', JSON.stringify(badges));
  }, [badges]);

  useEffect(() => {
    // Check for streak reset on load
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    if (lastPracticeDate && lastPracticeDate !== today && lastPracticeDate !== yesterdayStr) {
      setStreak(0);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('tikun_dark', String(isDarkMode));
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  const handlePsalmClick = (n: number) => {
    if (completed.includes(n)) {
      setConfirmData({ type: 'remove', psalm: n });
    } else {
      setCurrentP(n);
      setActiveWords(new Set());
      setIsListening(false);
    }
  };

  const handleFastValidate = (n: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (completed.includes(n)) {
      setConfirmData({ type: 'remove', psalm: n });
    } else {
      setCompleted(prev => {
        if (!prev.includes(n)) return [...prev, n];
        return prev;
      });
      confetti({ particleCount: 50, spread: 60 });
    }
  };

  const resetAll = () => {
    setConfirmData({ type: 'reset' });
  };

  const executeConfirm = () => {
    if (!confirmData) return;
    if (confirmData.type === 'reset') {
      setCompleted([]);
      setPoints(0);
      setStreak(0);
      setBadges([]);
      setLastPracticeDate(null);
      localStorage.setItem('tikun_c', "[]");
      localStorage.setItem('tikun_pts', "0");
      localStorage.setItem('tikun_strk', "0");
      localStorage.setItem('tikun_badges', "[]");
      localStorage.removeItem('tikun_last_date');
    } else if (confirmData.type === 'remove' && confirmData.psalm) {
      setCompleted(prev => prev.filter(id => id !== confirmData.psalm));
    }
    setConfirmData(null);
  };

  const currentRankIndex = completed.length;

  const badgeIcons: Record<string, string> = {
    first_word: "🎤",
    first_psalm: "📜",
    halfway: "🛡️",
    tikun_master: "🏆",
    streak_3: "🔥",
    streak_7: "💎",
    nanach: "✨"
  };

  return (
    <div className="min-h-screen p-4 transition-colors duration-300">
      {/* Badge Earned Toast */}
      <AnimatePresence>
        {newBadge && (
          <motion.div 
            initial={{ x: 300, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 300, opacity: 0 }}
            className="fixed top-4 right-4 z-[200] flex items-center gap-4 bg-white dark:bg-gray-800 p-4 rounded-3xl border-4 border-[var(--jaune)] shadow-2xl max-w-xs cursor-pointer"
            onClick={() => setNewBadge(null)}
          >
            <div className="text-4xl shrink-0">{badgeIcons[newBadge]}</div>
            <div className="flex flex-col">
              <h2 className="text-sm font-black text-[var(--bordeaux)] uppercase leading-tight">{t[`badge_${newBadge}`]}</h2>
              <p className="text-xs font-bold text-[var(--text-main)] opacity-80">{t[`badge_${newBadge}_desc`]}</p>
            </div>
            <button className="ml-2 text-[var(--text-muted)] hover:text-[var(--bordeaux)]">
              <X size={16} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header Tools */}
      <ConfirmModal 
        isOpen={confirmData !== null}
        title={confirmData?.type === 'reset' ? t.confirmReset : t.confirmRemove + confirmData?.psalm + "?"}
        yesText={t.yes}
        noText={t.no}
        onConfirm={executeConfirm}
        onCancel={() => setConfirmData(null)}
      />
      <div className="flex justify-between items-center mb-4 max-w-lg mx-auto">
        <div className="flex gap-2 items-center">
          <div className="flex flex-col items-center bg-white dark:bg-gray-800 px-3 py-1 rounded-2xl border-2 border-[var(--jaune)] shadow-sm">
            <span className="text-[10px] font-black text-[var(--text-muted)] uppercase">{t.points}</span>
            <span className="text-lg font-black text-[var(--jaune)] leading-none">{points}</span>
          </div>
          <div className="flex flex-col items-center bg-white dark:bg-gray-800 px-3 py-1 rounded-2xl border-2 border-[var(--bordeaux)] shadow-sm">
            <span className="text-[10px] font-black text-[var(--text-muted)] uppercase">{t.streak}</span>
            <span className="text-lg font-black text-[var(--bordeaux)] leading-none">{streak} 🔥</span>
          </div>
        </div>
        <div className="flex gap-2">
          {['he', 'fr', 'en', 'es'].map(l => (
            <motion.button
              key={l}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => setLang(l)}
              className={`px-3 py-1.5 rounded-xl border-2 text-xs font-bold transition-all ${
                lang === l 
                  ? 'bg-[var(--bordeaux)] border-[var(--bordeaux)] text-white shadow-md' 
                  : 'bg-[var(--card-bg)] border-[var(--gris)] text-[var(--text-muted)] hover:border-[var(--bordeaux)] hover:text-[var(--bordeaux)]'
              }`}
            >
              {l === 'he' ? 'עברית' : l.toUpperCase()}
            </motion.button>
          ))}
        </div>
        <motion.button
          whileHover={{ scale: 1.1, rotate: 15 }}
          whileTap={{ scale: 0.9 }}
          onClick={() => setIsDarkMode(!isDarkMode)}
          className="p-2.5 rounded-full bg-[var(--card-bg)] border-2 border-[var(--bordeaux)] text-[var(--bordeaux)] shadow-md transition-transform"
          aria-label="Toggle Dark Mode"
        >
          {isDarkMode ? <Sun size={22} /> : <Moon size={22} />}
        </motion.button>
      </div>

      <AnimatePresence mode="wait">
        {currentP === null ? (
          <motion.div 
            key="home"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            id="home" 
            className="max-w-lg mx-auto"
          >
            <h2 className="display-text text-4xl text-[var(--bordeaux)] text-center mb-4">{t.mainTitle}</h2>
            
            <motion.div 
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className="bg-white dark:bg-gray-800 p-8 rounded-[2.5rem] shadow-xl border-4 border-[var(--bordeaux)] mb-10 text-center transform hover:rotate-1 transition-transform"
            >
              <div className="text-3xl font-black text-[var(--bordeaux)] mb-3 uppercase tracking-wider">{t.ranks[currentRankIndex]}</div>
              <motion.div 
                animate={{ scale: [1, 1.1, 1] }}
                transition={{ repeat: Infinity, duration: 3 }}
                className="text-7xl mb-6 drop-shadow-lg"
              >
                {emojiRanks[currentRankIndex]}
              </motion.div>
              <div className="w-full bg-[var(--gris)] h-8 rounded-full border-4 border-[var(--bordeaux)] overflow-hidden mb-4 shadow-inner">
                <motion.div 
                  initial={{ width: 0 }}
                  animate={{ width: `${completed.length * 10}%` }}
                  className="h-full rainbow-animate transition-all duration-1000 ease-out" 
                  style={{ 
                    background: 'var(--rainbow)',
                    backgroundSize: '200% 100%'
                  }}
                />
              </div>
              <div className="text-lg font-bold text-[var(--text-main)]">
                {t.completed} <span className="text-3xl text-[var(--jaune)]">{completed.length}</span> {t.outOf}
              </div>
            </motion.div>

            {/* Badges Section */}
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="mb-10"
            >
              <h3 className="text-center font-black text-[var(--text-muted)] uppercase tracking-widest mb-4 text-sm">{t.badges}</h3>
              <div className="flex flex-wrap justify-center gap-4">
                {Object.keys(badgeIcons).map(bid => {
                  const earned = badges.includes(bid);
                  return (
                    <motion.div 
                      key={bid}
                      whileHover={earned ? { scale: 1.1 } : {}}
                      className={`w-14 h-14 rounded-2xl flex items-center justify-center text-2xl border-4 transition-all ${
                        earned 
                          ? 'bg-white border-[var(--jaune)] shadow-md grayscale-0 opacity-100' 
                          : 'bg-gray-100 border-gray-200 grayscale opacity-30'
                      }`}
                      title={earned ? t[`badge_${bid}`] : "???"}
                    >
                      {badgeIcons[bid]}
                    </motion.div>
                  );
                })}
              </div>
            </motion.div>

            <motion.div 
              initial="hidden"
              animate="visible"
              variants={{
                visible: { transition: { staggerChildren: 0.05 } }
              }}
              className="grid grid-cols-3 sm:grid-cols-5 gap-4 justify-items-center"
            >
              {psalmList.map(n => {
                const isDone = completed.includes(n);
                return (
                  <motion.div 
                    key={n} 
                    variants={{
                      hidden: { scale: 0, opacity: 0 },
                      visible: { scale: 1, opacity: 1 }
                    }}
                    className="relative group"
                  >
                    <motion.button
                      whileHover={{ scale: 1.1 }}
                      whileTap={{ scale: 0.9 }}
                      onClick={(e) => handleFastValidate(n, e)}
                      className={`absolute -top-3 -left-3 w-10 h-10 rounded-full border-4 flex items-center justify-center z-10 transition-all shadow-md ${
                        isDone 
                          ? 'bg-white border-[var(--vert)] text-[var(--vert)]' 
                          : 'bg-white border-[var(--gris)] text-[var(--text-muted)] opacity-60 hover:opacity-100'
                      }`}
                    >
                      {isDone ? <CheckCircle2 size={20} /> : <Wand2 size={20} />}
                    </motion.button>
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => handlePsalmClick(n)}
                      className={`w-16 h-16 sm:w-20 sm:h-20 rounded-3xl border-4 flex items-center justify-center text-2xl font-black transition-all ${
                        isDone
                          ? 'bg-[var(--vert)] border-green-700 text-white shadow-[0_6px_0_rgb(21,128,61)]'
                          : 'bg-white border-[var(--bordeaux)] text-[var(--bordeaux)] shadow-[0_6px_0_rgb(29,78,216)]'
                      }`}
                    >
                      {n}
                    </motion.button>
                  </motion.div>
                );
              })}
            </motion.div>

            <div className="flex flex-col sm:flex-row gap-4 justify-center mt-12">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setShowTutorial(true)} 
                className="flex items-center justify-center gap-2 bg-white border-4 border-[var(--jaune)] px-8 py-4 rounded-3xl text-lg font-black text-[var(--text-main)] shadow-[0_6px_0_var(--jaune)] hover:bg-[var(--jaune)] hover:text-white transition-all"
              >
                <Wand2 size={24} className="text-[var(--jaune)] group-hover:text-white" /> {t.tutorial}
              </motion.button>
              
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={resetAll} 
                className="opacity-60 hover:opacity-100 transition-all text-sm font-black flex items-center justify-center gap-2 bg-white border-4 border-[var(--gris)] px-6 py-3 rounded-full text-[var(--text-muted)] shadow-md"
              >
                <RotateCcw size={18} /> {t.reset}
              </motion.button>
            </div>
          </motion.div>
        ) : (
          <motion.div 
            key="game"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            id="game-area" 
            className="max-w-3xl mx-auto"
          >
            <div className="flex justify-between items-center mb-6 gap-2">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => {
                  setCurrentP(null);
                  setIsListening(false);
                }} 
                className="flex items-center gap-2 px-4 sm:px-6 py-3 bg-white border-4 border-[var(--gris)] rounded-2xl text-sm font-black shadow-md transition-all"
              >
                <ArrowLeft size={18} /> {t.back}
              </motion.button>

              <div className="flex flex-col items-center">
                <h2 className="display-text text-2xl sm:text-3xl text-[var(--bordeaux)]">
                  {lang === 'he' ? 'פרק ' : 'Psalm '} {currentP}
                </h2>
                {SpeechRecognition && (
                  <div className="flex gap-2 mt-2">
                    <motion.button
                      whileHover={{ scale: 1.1 }}
                      whileTap={{ scale: 0.9 }}
                      onClick={() => setIsListening(!isListening)}
                      className={`p-3 rounded-full border-4 transition-all shadow-lg ${
                        isListening 
                          ? 'bg-[var(--jaune)] border-orange-700 text-white animate-pulse' 
                          : 'bg-white border-[var(--gris)] text-[var(--text-muted)]'
                      }`}
                      title={isListening ? t.micOn : t.micOff}
                    >
                      {isListening ? <Mic size={24} /> : <MicOff size={24} />}
                    </motion.button>
                    
                    <motion.button
                      whileHover={{ scale: 1.1 }}
                      whileTap={{ scale: 0.9 }}
                      onClick={() => {
                        if (nextWordIndex !== -1) {
                          speakWord(currentPsalmWords[nextWordIndex], nextWordIndex);
                        }
                      }}
                      disabled={isSpeaking !== null || nextWordIndex === -1}
                      className={`p-3 rounded-full border-4 transition-all shadow-lg ${
                        isSpeaking !== null
                          ? 'bg-[var(--bordeaux)] border-blue-900 text-white'
                          : 'bg-white border-[var(--gris)] text-[var(--text-muted)] hover:border-[var(--bordeaux)] hover:text-[var(--bordeaux)]'
                      } disabled:opacity-50`}
                    >
                      {isSpeaking !== null ? <Loader2 size={24} className="animate-spin" /> : <Volume2 size={24} />}
                    </motion.button>
                  </div>
                )}
                {micError && (
                  <span className="text-xs text-red-500 font-bold mt-1 text-center max-w-[150px]">{micError}</span>
                )}
              </div>

              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => {
                  const all = new Set(currentPsalmWords.map((_, i) => i));
                  setActiveWords(all);
                }} 
                className="px-4 sm:px-6 py-3 bg-[var(--jaune)] text-white rounded-2xl text-sm font-black flex items-center gap-2 shadow-[0_4px_0_rgb(194,65,12)] transition-all"
              >
                <Wand2 size={18} /> {t.selectAll}
              </motion.button>
            </div>

            <div className="w-full bg-[var(--gris)] h-2 rounded-full overflow-hidden mb-8">
              <motion.div 
                initial={{ width: 0 }}
                animate={{ width: `${(activeWords.size / currentPsalmWords.length) * 100}%` }}
                className="h-full bg-[var(--vert)] transition-all duration-300" 
              />
            </div>

            <div 
              className="hebrew-text text-3xl sm:text-4xl leading-[3] sm:leading-[3.5] text-center text-[var(--text-main)] selection:bg-[var(--jaune)]"
              dir="rtl"
            >
              {currentPsalmWords.map((word, index) => (
                <motion.span
                  key={index}
                  initial={false}
                  animate={{
                    scale: index === nextWordIndex ? 1.15 : 1,
                    y: index === nextWordIndex ? -4 : 0
                  }}
                  onClick={() => handleToggleWord(index)}
                  className={`inline-block mx-2 my-1 px-3 py-1 rounded-2xl cursor-pointer transition-all border-b-4 relative ${
                    activeWords.has(index)
                      ? 'bg-[var(--vert)] text-white border-green-700 shadow-inner'
                      : index === nextWordIndex
                        ? 'bg-[var(--active-word)] border-[var(--jaune)] shadow-[0_0_15px_var(--jaune)] z-10 font-black'
                        : 'bg-[var(--card-bg)] border-[var(--gris)] text-[var(--text-muted)] hover:border-[var(--bordeaux)]'
                  }`}
                >
                  <div className="flex items-center gap-1">
                    {word}
                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        speakWord(word, index);
                      }}
                      className={`p-1 rounded-full hover:bg-black/10 transition-colors ${isSpeaking === index ? 'text-[var(--jaune)]' : ''}`}
                    >
                      {isSpeaking === index ? <Loader2 size={14} className="animate-spin" /> : <Volume2 size={14} />}
                    </button>
                  </div>
                </motion.span>
              ))}
            </div>

            {/* Completion Overlays */}
            <AnimatePresence>
              {completed.includes(currentP) && activeWords.size === currentPsalmWords.length && (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed inset-0 bg-[var(--fond)] z-50 flex flex-col items-center justify-center p-6"
                >
                  <motion.div 
                    initial={{ scale: 0, rotate: -180 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ type: 'spring', damping: 12 }}
                    className="text-9xl mb-6 drop-shadow-2xl"
                  >
                    {emojiRanks[completed.length]}
                  </motion.div>
                  <motion.h1 
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.2 }}
                    className="display-text text-7xl text-[var(--vert)] mb-4 drop-shadow-md"
                  >
                    {t.wellDone}
                  </motion.h1>
                  <motion.p 
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.3 }}
                    className="text-2xl mb-10 text-center font-black text-[var(--text-main)]"
                  >
                    {lang === 'he' ? 'עלית לדרגת: ' : 'New Rank: '} 
                    <span className="text-[var(--jaune)]">{t.ranks[completed.length]}</span>
                  </motion.p>
                  
                  {completed.length === 10 ? (
                    <motion.div 
                      initial={{ scale: 0.8, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ delay: 0.5 }}
                      className="text-center bg-white p-10 rounded-[3rem] shadow-2xl border-8 border-[var(--jaune)]"
                    >
                      <h2 className="display-text text-5xl text-[var(--bordeaux)] mb-6">{t.finalTitle}</h2>
                      <p className="text-xl mb-10 font-bold leading-relaxed" dangerouslySetInnerHTML={{ __html: t.finalMsg }} />
                      <motion.button 
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={resetAll}
                        className="px-12 py-5 bg-[var(--bordeaux)] text-white rounded-3xl text-2xl font-black shadow-[0_8px_0_rgb(29,78,216)] transition-all"
                      >
                        {t.restart}
                      </motion.button>
                    </motion.div>
                  ) : (
                    <motion.button 
                      initial={{ scale: 0.8, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ delay: 0.5 }}
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => setCurrentP(null)}
                      className="px-12 py-5 bg-[var(--bordeaux)] text-white rounded-3xl text-2xl font-black shadow-[0_8px_0_rgb(29,78,216)] transition-all"
                    >
                      {t.returnMenu}
                    </motion.button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
      <Tutorial 
        isOpen={showTutorial}
        lang={lang}
        onFinish={() => {
          setShowTutorial(false);
          localStorage.setItem('tikun_tutorial_seen', 'true');
        }}
        onSkip={() => {
          setShowTutorial(false);
          localStorage.setItem('tikun_tutorial_seen', 'true');
        }}
        onAwardBadge={handleAwardBadge}
      />
    </div>
  );
}
