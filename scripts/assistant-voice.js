/**
 * Real-Time Voice Assistant Daemon for Antigravity IDE
 *
 * Listens to active conversation responses and speaks them out loud
 * using native Windows Speech Synthesis with zero external dependencies.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain');
const TEMP_SPEECH_FILE = path.join(__dirname, '.temp_speech.txt');

// Cleans raw markdown into conversational speech
function cleanForSpeech(markdown) {
  if (!markdown) return '';

  let text = markdown;

  // 1. Remove fenced code blocks
  text = text.replace(/```[\s\S]*?```/g, ' [code omitted] ');

  // 2. Remove inline code
  text = text.replace(/`([^`]+)`/g, '$1');

  // 3. Remove markdown links: [label](url) -> label
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 4. Remove image tags: ![alt](url) -> ''
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '');

  // 5. Remove headers (###, ##, #)
  text = text.replace(/^#{1,6}\s+/gm, '');

  // 6. Remove bold and italics (*, _)
  text = text.replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1');

  // 7. Remove blockquotes and alerts (> ...)
  text = text.replace(/^>\s*(\[!NOTE\]|\[!TIP\]|\[!IMPORTANT\]|\[!WARNING\])?\s*/gm, '');

  // 8. Remove HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // 9. Remove markdown tables (| header | ...)
  text = text.replace(/^\|.*\|$/gm, '');

  // 10. Replace common symbols and dashes with smooth words
  text = text.replace(/➔|->/g, ' to ');
  text = text.replace(/\+/g, ' plus ');

  // 11. Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();

  // Extract the first 2-3 sentences for a crisp, natural worker update
  const sentenceMatches = text.match(/[^.!?]+[.!?]+/g);
  let summary = text;
  if (sentenceMatches && sentenceMatches.length > 0) {
    summary = sentenceMatches.slice(0, 3).join(' ').trim();
  }

  // Cap at 350 characters to prevent endless monologue
  if (summary.length > 350) {
    summary = summary.substring(0, 350) + '... and more.';
  }

  return summary;
}

// Speaks text using native Windows Speech Synthesis (System.Speech)
function speak(text) {
  if (!text || text.trim().length === 0) return;

  try {
    fs.writeFileSync(TEMP_SPEECH_FILE, text, 'utf8');

    const escapedPath = TEMP_SPEECH_FILE.replace(/\\/g, '\\\\');
    const psScript = `
      Add-Type -AssemblyName System.Speech;
      $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;
      $synth.Rate = 1;
      $content = [System.IO.File]::ReadAllText('${escapedPath}');
      $synth.Speak($content);
    `.replace(/\n/g, ' ');

    execSync(`powershell -NoProfile -Command "${psScript}"`, { stdio: 'ignore' });
  } catch (err) {
    console.error('[Voice Assistant] Error speaking text:', err.message);
  } finally {
    try {
      if (fs.existsSync(TEMP_SPEECH_FILE)) fs.unlinkSync(TEMP_SPEECH_FILE);
    } catch (_) {}
  }
}

// Finds the most recently modified transcript file
function getActiveTranscriptPath() {
  if (!fs.existsSync(BRAIN_DIR)) return null;

  const entries = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
  let latestFile = null;
  let latestMtime = 0;

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const candidate = path.join(BRAIN_DIR, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(candidate)) {
        const stat = fs.statSync(candidate);
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
          latestFile = candidate;
        }
      }
    }
  }
  return latestFile;
}

// Main daemon loop
function startVoiceDaemon() {
  console.log('====================================================');
  console.log('   Antigravity Real-Time Voice Assistant (Daemon)   ');
  console.log('====================================================');

  const transcriptPath = getActiveTranscriptPath();
  if (!transcriptPath) {
    console.error('[Voice Assistant] Could not locate transcript file in:', BRAIN_DIR);
    process.exit(1);
  }

  console.log(`[Voice Assistant] Watching: ${transcriptPath}`);

  // Count existing lines to skip historical conversation
  const initialContent = fs.readFileSync(transcriptPath, 'utf8');
  let processedLines = initialContent.split('\n').filter(Boolean).length;
  console.log(`[Voice Assistant] Ready! Skipped ${processedLines} past messages.`);
  console.log('[Voice Assistant] Standing by for new assistant responses...\n');

  // Welcome announcement
  speak('Voice assistant online. I will announce my responses out loud as soon as tasks complete.');

  // Polling watcher (runs every 600ms)
  let isSpeaking = false;

  setInterval(() => {
    try {
      if (isSpeaking) return;

      const activePath = getActiveTranscriptPath() || transcriptPath;
      if (!fs.existsSync(activePath)) return;

      const content = fs.readFileSync(activePath, 'utf8');
      const lines = content.split('\n').filter(Boolean);

      if (lines.length > processedLines) {
        for (let i = processedLines; i < lines.length; i++) {
          try {
            const entry = JSON.parse(lines[i]);
            // Only announce model planner responses that contain user-facing content
            if (
              entry.source === 'MODEL' &&
              entry.type === 'PLANNER_RESPONSE' &&
              entry.content &&
              entry.content.trim().length > 0 &&
              !entry.tool_calls
            ) {
              const speechText = cleanForSpeech(entry.content);
              if (speechText) {
                console.log(`\n[${new Date().toLocaleTimeString()}] Speaking response:`);
                console.log(`"${speechText}"\n`);
                isSpeaking = true;
                speak(speechText);
                isSpeaking = false;
              }
            }
          } catch (_) {}
        }
        processedLines = lines.length;
      }
    } catch (err) {
      // Ignore transient file lock / read errors
    }
  }, 600);
}

startVoiceDaemon();
