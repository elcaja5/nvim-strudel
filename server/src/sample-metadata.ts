/**
 * SampleMetadata - Tracks pitch information for sample banks
 * 
 * Strudel samples can be:
 * 1. Pitched (keyed by note name): {"A0": "file.mp3", "C1": "file.mp3"}
 *    - Need to calculate n (sample index) and speed (pitch shift) from MIDI note
 * 2. Non-pitched (arrays): ["kick.wav", "snare.wav"]
 *    - Just use n as direct sample index
 * 
 * This module stores metadata about each bank so osc-output.ts can correctly
 * map note/midinote to SuperDirt's n + speed parameters.
 */

import { isNote, noteToMidi } from '@strudel/core/util.mjs';

export interface SampleMapping {
  /** Sample index in the bank */
  n: number;
  /** MIDI note this sample represents (e.g., 21 for A0) */
  midi: number;
}

export interface BankMetadata {
  /** Bank name (e.g., "piano") */
  name: string;
  /** True if this is a pitched sample bank */
  isPitched: boolean;
  /** For pitched banks: mapping from n to MIDI note */
  sampleMidiNotes?: number[];
  /** Total number of samples in the bank */
  sampleCount: number;
  /** True if this is a soundfont (needs envelope) */
  isSoundfont?: boolean;
}

// Global registry of bank metadata
const bankRegistry = new Map<string, BankMetadata>();

/**
 * Parse a note name to MIDI number
 * Handles formats like: A0, C1, Ds1 (D#1), Fs4 (F#4), Bb3, etc.
 */
function parseNoteName(name: string): number | null {
  // Handle 's' suffix for sharps (e.g., "Ds1" = D#1, "Fs4" = F#4)
  const normalized = name.replace(/s(\d)/, '#$1');
  
  const match = normalized.match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
  if (!match) return null;
  
  const noteMap: Record<string, number> = {
    'C': 0, 'c': 0,
    'D': 2, 'd': 2,
    'E': 4, 'e': 4,
    'F': 5, 'f': 5,
    'G': 7, 'g': 7,
    'A': 9, 'a': 9,
    'B': 11, 'b': 11,
  };
  
  let semitone = noteMap[match[1]];
  if (semitone === undefined) return null;
  
  if (match[2] === '#') semitone += 1;
  else if (match[2] === 'b') semitone -= 1;
  
  const octave = parseInt(match[3], 10);
  // MIDI note: C-1 = 0, C0 = 12, C4 = 60
  return (octave + 1) * 12 + semitone;
}

/**
 * Register a sample bank's metadata from its JSON structure
 * 
 * @param bankName Name of the bank (e.g., "piano")
 * @param samples The samples data from JSON - either an array or note-keyed object
 */
export function registerBankMetadata(
  bankName: string,
  samples: string[] | Record<string, string>
): BankMetadata {
  let metadata: BankMetadata;
  
  if (Array.isArray(samples)) {
    // Non-pitched: array of filenames
    metadata = {
      name: bankName,
      isPitched: false,
      sampleCount: samples.length,
    };
  } else {
    // Check if keys are note names
    const keys = Object.keys(samples);
    const noteKeys = keys.filter(k => !k.startsWith('_'));
    
    // Try to parse first few keys as notes
    const parsedNotes: Array<{ key: string; midi: number }> = [];
    for (const key of noteKeys) {
      const midi = parseNoteName(key);
      if (midi !== null) {
        parsedNotes.push({ key, midi });
      }
    }
    
    // If most keys are note names, this is a pitched bank
    const isPitched = parsedNotes.length > noteKeys.length * 0.5 && parsedNotes.length >= 2;
    
    if (isPitched) {
      // Sort by MIDI note to get sample indices
      parsedNotes.sort((a, b) => a.midi - b.midi);
      
      // Build array mapping n -> midi
      const sampleMidiNotes = parsedNotes.map(p => p.midi);
      
      metadata = {
        name: bankName,
        isPitched: true,
        sampleMidiNotes,
        sampleCount: sampleMidiNotes.length,
      };
      
      console.log(`[sample-metadata] Registered pitched bank '${bankName}': ${sampleMidiNotes.length} samples, range MIDI ${sampleMidiNotes[0]}-${sampleMidiNotes[sampleMidiNotes.length - 1]}`);
    } else {
      // Not pitched - treat as indexed samples
      metadata = {
        name: bankName,
        isPitched: false,
        sampleCount: noteKeys.length,
      };
    }
  }
  
  bankRegistry.set(bankName, metadata);
  return metadata;
}

/**
 * Get metadata for a bank
 */
export function getBankMetadata(bankName: string): BankMetadata | undefined {
  return bankRegistry.get(bankName);
}

/**
 * Check if a bank is pitched
 */
export function isBankPitched(bankName: string): boolean {
  return bankRegistry.get(bankName)?.isPitched ?? false;
}

/**
 * Check if a bank is a soundfont (needs envelope calculation)
 */
export function isBankSoundfont(bankName: string): boolean {
  return bankRegistry.get(bankName)?.isSoundfont ?? false;
}

/**
 * For a pitched bank, calculate the sample index (n) and speed adjustment
 * to play a given MIDI note.
 * 
 * Strategy: Find the closest sample and calculate speed ratio
 * speed = 2^((targetMidi - sampleMidi) / 12)
 * 
 * @param bankName The sample bank name
 * @param targetMidi The MIDI note to play
 * @returns { n, speed } or null if bank not found/not pitched
 */
export function calculateNAndSpeed(
  bankName: string,
  targetMidi: number
): { n: number; speed: number } | null {
  const metadata = bankRegistry.get(bankName);
  
  if (!metadata) {
    // Unknown bank - let SuperDirt handle it directly
    return null;
  }
  
  if (!metadata.isPitched || !metadata.sampleMidiNotes) {
    // Non-pitched bank - don't adjust, just return null to skip processing
    return null;
  }
  
  const samples = metadata.sampleMidiNotes;
  
  // Find closest sample by MIDI note
  let closestIndex = 0;
  let closestDistance = Math.abs(samples[0] - targetMidi);
  
  for (let i = 1; i < samples.length; i++) {
    const distance = Math.abs(samples[i] - targetMidi);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = i;
    }
  }
  
  const sampleMidi = samples[closestIndex];
  const speed = Math.pow(2, (targetMidi - sampleMidi) / 12);
  
  return { n: closestIndex, speed };
}

/**
 * Process a hap value for OSC output, adjusting n and speed for pitched samples
 * 
 * This mimics superdough's getCommonSampleInfo() logic:
 * 1. Get target MIDI from freq, note (string/number), or default to 36 (C2)
 * 2. Find closest sample by MIDI distance
 * 3. Calculate speed = 2^(transpose/12) where transpose = targetMidi - sampleMidi
 * 
 * @param value The hap value object
 * @returns Modified value with correct n and speed, or original if no adjustment needed
 */
export function processValueForOsc(value: Record<string, any>): Record<string, any> {
  // Get the sound/sample name
  const bankName = value.s || value.sound;
  if (!bankName) return value;
  
  // Check if we have metadata for this bank
  const metadata = bankRegistry.get(bankName);
  if (!metadata || !metadata.isPitched) {
    // Not a pitched bank we know about - pass through
    return value;
  }
  
  // Get the target note (same logic as superdough's valueToMidi with fallback 36)
  let targetMidi: number = 36; // Default C2, same as superdough
  
  if (typeof value.freq === 'number') {
    // freq takes priority (same as superdough)
    targetMidi = Math.round(12 * Math.log2(value.freq / 440) + 69);
  } else if (typeof value.note === 'number') {
    targetMidi = value.note;
  } else if (typeof value.note === 'string') {
    const parsed = parseNoteName(value.note);
    if (parsed !== null) {
      targetMidi = parsed;
    } else if (isNote(value.note)) {
      targetMidi = noteToMidi(value.note);
    }
  } else if (typeof value.midinote === 'number') {
    targetMidi = value.midinote;
  }
  // If none of the above, targetMidi stays at 36 (C2)
  
  // Calculate n and speed
  const result = calculateNAndSpeed(bankName, targetMidi);
  if (!result) return value;
  
  // Create new value with adjusted n and speed, removing pitch params that confuse SuperDirt
  const newValue = { ...value };
  newValue.n = result.n;
  newValue.speed = (newValue.speed ?? 1) * result.speed;
  
  // Remove params that SuperDirt might misinterpret
  delete newValue.note;
  delete newValue.midinote;
  delete newValue.freq;
  
  return newValue;
}

/**
 * Get all registered bank names
 */
export function getRegisteredBanks(): string[] {
  return Array.from(bankRegistry.keys());
}

/**
 * Register a soundfont bank from cached WAV files
 * Soundfont files are named like: 000_note24.wav, 001_note51.wav, etc.
 * where the number after "note" is the MIDI pitch for that sample
 * 
 * @param bankName Name of the bank (e.g., "gm_violin")
 * @param filenames Array of filenames in the bank directory
 */
export function registerSoundfontMetadata(
  bankName: string,
  filenames: string[]
): BankMetadata | null {
  // Parse filenames to extract MIDI notes
  // Format: 000_note24.wav -> { index: 0, midi: 24 }
  const samples: Array<{ index: number; midi: number }> = [];
  
  for (const filename of filenames) {
    const match = filename.match(/^(\d+)_note(\d+)\.wav$/);
    if (match) {
      samples.push({
        index: parseInt(match[1], 10),
        midi: parseInt(match[2], 10),
      });
    }
  }
  
  if (samples.length < 2) {
    // Not enough samples to be a pitched bank
    return null;
  }
  
  // Sort by index to ensure correct order
  samples.sort((a, b) => a.index - b.index);
  
  // Build MIDI note array (index -> midi)
  const sampleMidiNotes = samples.map(s => s.midi);
  
  const metadata: BankMetadata = {
    name: bankName,
    isPitched: true,
    sampleMidiNotes,
    sampleCount: sampleMidiNotes.length,
    isSoundfont: true,
  };
  
  bankRegistry.set(bankName, metadata);
  
  console.log(`[sample-metadata] Registered soundfont '${bankName}': ${sampleMidiNotes.length} samples, range MIDI ${sampleMidiNotes[0]}-${sampleMidiNotes[sampleMidiNotes.length - 1]}`);
  
  return metadata;
}

/**
 * Clear all registered metadata (for testing)
 */
export function clearMetadata(): void {
  bankRegistry.clear();
}
