#!/usr/bin/env node
/**
 * LSP server for Strudel mini-notation
 * Provides completions, hover, diagnostics, signature help, and code actions
 */

// IMPORTANT: Patch console.log BEFORE importing @strudel/mini
// @strudel/core prints "🌀 @strudel/core loaded 🌀" to stdout on import,
// which corrupts the LSP JSON-RPC protocol. We redirect it to stderr.
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  // Redirect to stderr to avoid corrupting LSP protocol
  console.error(...args);
};

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  InitializeResult,
  CompletionItem,
  CompletionItemKind,
  Hover,
  Diagnostic,
  DiagnosticSeverity,
  Position,
  Range,
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  TextEdit,
  MarkupKind,
} from 'vscode-languageserver/node.js';

import { TextDocument } from 'vscode-languageserver-textdocument';

// Dynamic import for @strudel/mini to ensure console.log patch runs first
// @ts-ignore - @strudel/mini has no type declarations
const { parse: parseMini, getLeaves: getMiniLeaves } = await import('@strudel/mini');

// Restore console.log after imports (connection.console.log goes to the right place anyway)
console.log = originalLog;

// Create connection using stdio
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// Dynamic sample list - will be populated from engine
let dynamicSamples: string[] = [];
let dynamicBanks: string[] = [];

// Default sample names (fallback when not connected to engine)
const DEFAULT_SAMPLE_NAMES = [
  // Drums
  'bd', 'sd', 'hh', 'oh', 'cp', 'mt', 'ht', 'lt', 'rim', 'cb', 'cr', 'rd', 'sh', 'tb', 'perc', 'misc', 'fx',
  // Piano
  'piano',
  // Synths
  'sine', 'saw', 'square', 'triangle', 'sawtooth', 'tri', 'white', 'pink', 'brown',
  // Misc samples
  'casio', 'jazz', 'metal', 'east', 'space', 'wind', 'insect', 'crow', 'numbers', 'mridangam',
  // Instruments from VCSL
  'violin', 'viola', 'cello', 'bass', 'flute', 'oboe', 'clarinet', 'bassoon',
  'trumpet', 'horn', 'trombone', 'tuba', 'glockenspiel', 'xylophone', 'vibraphone',
];

// Note names
const NOTE_NAMES = [
  'c', 'd', 'e', 'f', 'g', 'a', 'b',
  'cs', 'ds', 'fs', 'gs', 'as', // sharps
  'db', 'eb', 'gb', 'ab', 'bb', // flats
];

// Octaves
const OCTAVES = ['0', '1', '2', '3', '4', '5', '6', '7', '8'];

// Scale names
const SCALE_NAMES = [
  'major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'aeolian', 'ionian',
  'harmonicMinor', 'melodicMinor', 'pentatonic', 'blues', 'chromatic',
  'wholetone', 'diminished', 'augmented', 'bebop', 'hungarian', 'spanish',
];

// Voicing mode names (used with .mode() function)
// Format: "mode" or "mode:anchor" e.g., "above:c3"
const VOICING_MODES = [
  'above', 'below', 'between', 'duck', 'root', 'rootless',
];

// Effects/modifiers in mini-notation
const MINI_OPERATORS = [
  { label: '*', detail: 'Speed up (fast)', documentation: 'Multiply speed: bd*2 plays twice as fast' },
  { label: '/', detail: 'Slow down', documentation: 'Divide speed: bd/2 plays twice as slow' },
  { label: '!', detail: 'Replicate', documentation: 'Repeat element: bd!3 plays bd three times' },
  { label: '?', detail: 'Degrade/maybe', documentation: 'Random chance: bd? sometimes plays' },
  { label: '@', detail: 'Weight', documentation: 'Set duration weight: bd@2 takes twice as long' },
  { label: '~', detail: 'Rest/silence', documentation: 'Silent step' },
  { label: '<>', detail: 'Alternate', documentation: 'Alternate between patterns each cycle' },
  { label: '[]', detail: 'Subsequence', documentation: 'Group elements into subsequence' },
  { label: '{}', detail: 'Polyrhythm', documentation: 'Play patterns in parallel with different lengths' },
  { label: '(,)', detail: 'Euclidean rhythm', documentation: 'Euclidean distribution: bd(3,8) = 3 hits over 8 steps' },
  { label: ':', detail: 'Sample index', documentation: 'Select sample variant: bd:2' },
  { label: ',', detail: 'Parallel', documentation: 'Play patterns in parallel: bd, hh' },
  { label: '|', detail: 'Random choice', documentation: 'Random choice: bd | sd' },
];

// Function signatures with parameters
interface FunctionSignature {
  name: string;
  detail: string;
  documentation: string;
  signatures: {
    label: string;
    documentation?: string;
    parameters: { label: string; documentation: string }[];
  }[];
}

const STRUDEL_FUNCTIONS: FunctionSignature[] = [
  {
    name: 's',
    detail: 'Sound/sample',
    documentation: 'Play a sound or sample',
    signatures: [{
      label: 's(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Mini-notation pattern of sample names, e.g., "bd sd hh"' }],
    }],
  },
  {
    name: 'sound',
    detail: 'Sound/sample (alias for s)',
    documentation: 'Play a sound or sample',
    signatures: [{
      label: 'sound(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Mini-notation pattern of sample names' }],
    }],
  },
  {
    name: 'n',
    detail: 'Note number',
    documentation: 'Set note by MIDI number or pattern',
    signatures: [{
      label: 'n(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern of MIDI note numbers, e.g., "0 2 4 7"' }],
    }],
  },
  {
    name: 'note',
    detail: 'Note name',
    documentation: 'Set note by name',
    signatures: [{
      label: 'note(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern of note names, e.g., "c4 e4 g4"' }],
    }],
  },
  {
    name: 'fast',
    detail: 'Speed up pattern',
    documentation: 'Speed up the pattern by a factor',
    signatures: [{
      label: 'fast(factor)',
      parameters: [{ label: 'factor', documentation: 'Speed multiplier (2 = twice as fast)' }],
    }],
  },
  {
    name: 'slow',
    detail: 'Slow down pattern',
    documentation: 'Slow down the pattern by a factor',
    signatures: [{
      label: 'slow(factor)',
      parameters: [{ label: 'factor', documentation: 'Speed divisor (2 = twice as slow)' }],
    }],
  },
  {
    name: 'gain',
    detail: 'Volume',
    documentation: 'Set the volume/gain',
    signatures: [{
      label: 'gain(amount)',
      parameters: [{ label: 'amount', documentation: 'Volume level (0-1, can go higher for boost)' }],
    }],
  },
  {
    name: 'pan',
    detail: 'Stereo pan',
    documentation: 'Set stereo panning',
    signatures: [{
      label: 'pan(position)',
      parameters: [{ label: 'position', documentation: 'Pan position (0 = left, 0.5 = center, 1 = right)' }],
    }],
  },
  {
    name: 'speed',
    detail: 'Playback speed',
    documentation: 'Change sample playback speed (affects pitch)',
    signatures: [{
      label: 'speed(rate)',
      parameters: [{ label: 'rate', documentation: 'Playback rate (1 = normal, 2 = octave up, 0.5 = octave down, negative = reverse)' }],
    }],
  },
  {
    name: 'lpf',
    detail: 'Low-pass filter',
    documentation: 'Apply a low-pass filter',
    signatures: [{
      label: 'lpf(frequency)',
      parameters: [{ label: 'frequency', documentation: 'Cutoff frequency in Hz (e.g., 1000)' }],
    }, {
      label: 'lpf(frequency, resonance)',
      parameters: [
        { label: 'frequency', documentation: 'Cutoff frequency in Hz' },
        { label: 'resonance', documentation: 'Filter resonance (Q factor)' },
      ],
    }],
  },
  {
    name: 'hpf',
    detail: 'High-pass filter',
    documentation: 'Apply a high-pass filter',
    signatures: [{
      label: 'hpf(frequency)',
      parameters: [{ label: 'frequency', documentation: 'Cutoff frequency in Hz (e.g., 200)' }],
    }, {
      label: 'hpf(frequency, resonance)',
      parameters: [
        { label: 'frequency', documentation: 'Cutoff frequency in Hz' },
        { label: 'resonance', documentation: 'Filter resonance (Q factor)' },
      ],
    }],
  },
  {
    name: 'bpf',
    detail: 'Band-pass filter',
    documentation: 'Apply a band-pass filter',
    signatures: [{
      label: 'bpf(frequency)',
      parameters: [{ label: 'frequency', documentation: 'Center frequency in Hz' }],
    }, {
      label: 'bpf(frequency, resonance)',
      parameters: [
        { label: 'frequency', documentation: 'Center frequency in Hz' },
        { label: 'resonance', documentation: 'Filter resonance (Q factor, affects bandwidth)' },
      ],
    }],
  },
  {
    name: 'delay',
    detail: 'Delay effect',
    documentation: 'Add a delay/echo effect',
    signatures: [{
      label: 'delay(amount)',
      parameters: [{ label: 'amount', documentation: 'Delay wet/dry mix (0-1)' }],
    }, {
      label: 'delay(amount, time, feedback)',
      parameters: [
        { label: 'amount', documentation: 'Wet/dry mix (0-1)' },
        { label: 'time', documentation: 'Delay time in cycles (e.g., 0.5)' },
        { label: 'feedback', documentation: 'Feedback amount (0-1)' },
      ],
    }],
  },
  {
    name: 'room',
    detail: 'Reverb',
    documentation: 'Add reverb effect',
    signatures: [{
      label: 'room(size)',
      parameters: [{ label: 'size', documentation: 'Room size / reverb amount (0-1)' }],
    }],
  },
  {
    name: 'crush',
    detail: 'Bitcrush',
    documentation: 'Apply bitcrusher effect',
    signatures: [{
      label: 'crush(bits)',
      parameters: [{ label: 'bits', documentation: 'Bit depth (1-16, lower = more crushed)' }],
    }],
  },
  {
    name: 'coarse',
    detail: 'Sample rate reduction',
    documentation: 'Reduce sample rate for lo-fi effect',
    signatures: [{
      label: 'coarse(amount)',
      parameters: [{ label: 'amount', documentation: 'Reduction factor (higher = more aliasing)' }],
    }],
  },
  {
    name: 'vowel',
    detail: 'Vowel filter',
    documentation: 'Apply vowel formant filter',
    signatures: [{
      label: 'vowel(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern of vowels: a, e, i, o, u' }],
    }],
  },
  {
    name: 'euclid',
    detail: 'Euclidean rhythm',
    documentation: 'Apply Euclidean rhythm distribution',
    signatures: [{
      label: 'euclid(pulses, steps)',
      parameters: [
        { label: 'pulses', documentation: 'Number of pulses/hits' },
        { label: 'steps', documentation: 'Total number of steps' },
      ],
    }, {
      label: 'euclid(pulses, steps, rotation)',
      parameters: [
        { label: 'pulses', documentation: 'Number of pulses/hits' },
        { label: 'steps', documentation: 'Total number of steps' },
        { label: 'rotation', documentation: 'Rotation offset' },
      ],
    }],
  },
  {
    name: 'every',
    detail: 'Apply every N cycles',
    documentation: 'Apply a function every N cycles',
    signatures: [{
      label: 'every(n, function)',
      parameters: [
        { label: 'n', documentation: 'Number of cycles' },
        { label: 'function', documentation: 'Function to apply, e.g., rev or fast(2)' },
      ],
    }],
  },
  {
    name: 'rev',
    detail: 'Reverse',
    documentation: 'Reverse the pattern',
    signatures: [{
      label: 'rev()',
      parameters: [],
    }],
  },
  {
    name: 'jux',
    detail: 'Juxtapose',
    documentation: 'Apply function to right channel only',
    signatures: [{
      label: 'jux(function)',
      parameters: [{ label: 'function', documentation: 'Function to apply to right channel' }],
    }],
  },
  {
    name: 'stack',
    detail: 'Stack patterns',
    documentation: 'Play multiple patterns simultaneously',
    signatures: [{
      label: 'stack(pattern1, pattern2, ...)',
      parameters: [{ label: 'patterns', documentation: 'Patterns to play in parallel' }],
    }],
  },
  {
    name: 'cat',
    detail: 'Concatenate',
    documentation: 'Play patterns in sequence',
    signatures: [{
      label: 'cat(pattern1, pattern2, ...)',
      parameters: [{ label: 'patterns', documentation: 'Patterns to play in sequence' }],
    }],
  },
  {
    name: 'sometimes',
    detail: 'Apply sometimes (50%)',
    documentation: 'Apply function with 50% probability',
    signatures: [{
      label: 'sometimes(function)',
      parameters: [{ label: 'function', documentation: 'Function to sometimes apply' }],
    }],
  },
  {
    name: 'often',
    detail: 'Apply often (75%)',
    documentation: 'Apply function with 75% probability',
    signatures: [{
      label: 'often(function)',
      parameters: [{ label: 'function', documentation: 'Function to often apply' }],
    }],
  },
  {
    name: 'rarely',
    detail: 'Apply rarely (25%)',
    documentation: 'Apply function with 25% probability',
    signatures: [{
      label: 'rarely(function)',
      parameters: [{ label: 'function', documentation: 'Function to rarely apply' }],
    }],
  },
  {
    name: 'almostAlways',
    detail: 'Apply almost always (90%)',
    documentation: 'Apply function with 90% probability',
    signatures: [{
      label: 'almostAlways(function)',
      parameters: [{ label: 'function', documentation: 'Function to almost always apply' }],
    }],
  },
  {
    name: 'almostNever',
    detail: 'Apply almost never (10%)',
    documentation: 'Apply function with 10% probability',
    signatures: [{
      label: 'almostNever(function)',
      parameters: [{ label: 'function', documentation: 'Function to almost never apply' }],
    }],
  },
  {
    name: 'bank',
    detail: 'Sample bank',
    documentation: 'Set the sample bank (drum machine)',
    signatures: [{
      label: 'bank(name)',
      parameters: [{ label: 'name', documentation: 'Bank name, e.g., "RolandTR808" or "TR808"' }],
    }],
  },
  {
    name: 'scale',
    detail: 'Musical scale',
    documentation: 'Quantize notes to a scale',
    signatures: [{
      label: 'scale(name)',
      parameters: [{ label: 'name', documentation: 'Scale name, e.g., "major", "minor", "dorian"' }],
    }],
  },
  {
    name: 'struct',
    detail: 'Structure',
    documentation: 'Apply rhythmic structure from another pattern',
    signatures: [{
      label: 'struct(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Boolean pattern for rhythm, e.g., "t f t f"' }],
    }],
  },
  {
    name: 'mask',
    detail: 'Mask pattern',
    documentation: 'Mask pattern with boolean pattern',
    signatures: [{
      label: 'mask(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Boolean pattern to mask with' }],
    }],
  },
  {
    name: 'clip',
    detail: 'Clip duration',
    documentation: 'Multiply event duration',
    signatures: [{
      label: 'clip(factor)',
      parameters: [{ label: 'factor', documentation: 'Duration multiplier (1 = full, 0.5 = half)' }],
    }],
  },
  {
    name: 'attack',
    detail: 'Attack time',
    documentation: 'Set envelope attack time',
    signatures: [{
      label: 'attack(time)',
      parameters: [{ label: 'time', documentation: 'Attack time in seconds' }],
    }],
  },
  {
    name: 'decay',
    detail: 'Decay time',
    documentation: 'Set envelope decay time',
    signatures: [{
      label: 'decay(time)',
      parameters: [{ label: 'time', documentation: 'Decay time in seconds' }],
    }],
  },
  {
    name: 'sustain',
    detail: 'Sustain level',
    documentation: 'Set envelope sustain level',
    signatures: [{
      label: 'sustain(level)',
      parameters: [{ label: 'level', documentation: 'Sustain level (0-1)' }],
    }],
  },
  {
    name: 'release',
    detail: 'Release time',
    documentation: 'Set envelope release time',
    signatures: [{
      label: 'release(time)',
      parameters: [{ label: 'time', documentation: 'Release time in seconds' }],
    }],
  },
  {
    name: 'begin',
    detail: 'Sample start',
    documentation: 'Set sample playback start position',
    signatures: [{
      label: 'begin(position)',
      parameters: [{ label: 'position', documentation: 'Start position (0-1, 0 = beginning)' }],
    }],
  },
  {
    name: 'end',
    detail: 'Sample end',
    documentation: 'Set sample playback end position',
    signatures: [{
      label: 'end(position)',
      parameters: [{ label: 'position', documentation: 'End position (0-1, 1 = end)' }],
    }],
  },
  {
    name: 'cut',
    detail: 'Cut group',
    documentation: 'Stop other sounds in same cut group (like hi-hat choke)',
    signatures: [{
      label: 'cut(group)',
      parameters: [{ label: 'group', documentation: 'Cut group number' }],
    }],
  },
  {
    name: 'chop',
    detail: 'Chop sample',
    documentation: 'Chop sample into N parts for granular effects',
    signatures: [{
      label: 'chop(parts)',
      parameters: [{ label: 'parts', documentation: 'Number of parts to chop into' }],
    }],
  },
  {
    name: 'slice',
    detail: 'Slice sample',
    documentation: 'Slice sample and select which slice to play',
    signatures: [{
      label: 'slice(total, which)',
      parameters: [
        { label: 'total', documentation: 'Total number of slices' },
        { label: 'which', documentation: 'Pattern of slice indices to play' },
      ],
    }],
  },
  {
    name: 'loopAt',
    detail: 'Loop at cycles',
    documentation: 'Adjust sample speed to loop over N cycles',
    signatures: [{
      label: 'loopAt(cycles)',
      parameters: [{ label: 'cycles', documentation: 'Number of cycles for the loop' }],
    }],
  },
  {
    name: 'fit',
    detail: 'Fit to cycle',
    documentation: 'Fit sample to event duration',
    signatures: [{
      label: 'fit()',
      parameters: [],
    }],
  },
  {
    name: 'striate',
    detail: 'Striate',
    documentation: 'Granular time-stretch effect',
    signatures: [{
      label: 'striate(parts)',
      parameters: [{ label: 'parts', documentation: 'Number of parts to striate into' }],
    }],
  },
  {
    name: 'orbit',
    detail: 'Effect bus',
    documentation: 'Route to effect bus (for shared effects)',
    signatures: [{
      label: 'orbit(bus)',
      parameters: [{ label: 'bus', documentation: 'Effect bus number (0-11)' }],
    }],
  },
  // REPL control functions
  {
    name: 'hush',
    detail: 'Stop all sounds',
    documentation: 'Emergency stop - silences all sounds immediately (panic button)',
    signatures: [{
      label: 'hush()',
      parameters: [],
    }],
  },
  {
    name: 'setcps',
    detail: 'Set tempo',
    documentation: 'Set the tempo in cycles per second. 1 = 1 cycle per second, 0.5 = 1 cycle every 2 seconds',
    signatures: [{
      label: 'setcps(cps)',
      parameters: [{ label: 'cps', documentation: 'Cycles per second (e.g., 0.5 for half speed, 2 for double speed)' }],
    }],
  },
  // Time modifiers
  {
    name: 'early',
    detail: 'Shift earlier',
    documentation: 'Shift pattern earlier in time by the given amount',
    signatures: [{
      label: 'early(amount)',
      parameters: [{ label: 'amount', documentation: 'Amount to shift earlier (in cycles)' }],
    }],
  },
  {
    name: 'late',
    detail: 'Shift later',
    documentation: 'Shift pattern later in time by the given amount',
    signatures: [{
      label: 'late(amount)',
      parameters: [{ label: 'amount', documentation: 'Amount to shift later (in cycles)' }],
    }],
  },
  {
    name: 'ply',
    detail: 'Multiply events',
    documentation: 'Multiply each event in the pattern, subdividing it',
    signatures: [{
      label: 'ply(factor)',
      parameters: [{ label: 'factor', documentation: 'Number of times to subdivide each event' }],
    }],
  },
  {
    name: 'segment',
    detail: 'Segment pattern',
    documentation: 'Sample the pattern at a fixed number of segments per cycle',
    signatures: [{
      label: 'segment(n)',
      parameters: [{ label: 'n', documentation: 'Number of segments per cycle' }],
    }],
  },
  {
    name: 'iter',
    detail: 'Iterate pattern',
    documentation: 'Shift the pattern by 1/n each cycle, cycling through variations',
    signatures: [{
      label: 'iter(n)',
      parameters: [{ label: 'n', documentation: 'Number of iterations before repeating' }],
    }],
  },
  {
    name: 'iterBack',
    detail: 'Iterate backwards',
    documentation: 'Like iter but shifts in the opposite direction',
    signatures: [{
      label: 'iterBack(n)',
      parameters: [{ label: 'n', documentation: 'Number of iterations before repeating' }],
    }],
  },
  {
    name: 'palindrome',
    detail: 'Palindrome',
    documentation: 'Play pattern forwards then backwards',
    signatures: [{
      label: 'palindrome()',
      parameters: [],
    }],
  },
  {
    name: 'compress',
    detail: 'Compress time',
    documentation: 'Compress pattern into a portion of the cycle',
    signatures: [{
      label: 'compress(start, end)',
      parameters: [
        { label: 'start', documentation: 'Start position (0-1)' },
        { label: 'end', documentation: 'End position (0-1)' },
      ],
    }],
  },
  {
    name: 'zoom',
    detail: 'Zoom into pattern',
    documentation: 'Zoom into a portion of the pattern',
    signatures: [{
      label: 'zoom(start, end)',
      parameters: [
        { label: 'start', documentation: 'Start position (0-1)' },
        { label: 'end', documentation: 'End position (0-1)' },
      ],
    }],
  },
  {
    name: 'linger',
    detail: 'Linger on portion',
    documentation: 'Only play the first portion of the pattern, looping it',
    signatures: [{
      label: 'linger(fraction)',
      parameters: [{ label: 'fraction', documentation: 'Fraction of pattern to loop (e.g., 0.25 = first quarter)' }],
    }],
  },
  {
    name: 'fastGap',
    detail: 'Fast with gap',
    documentation: 'Speed up pattern but leave a gap, maintaining cycle length',
    signatures: [{
      label: 'fastGap(factor)',
      parameters: [{ label: 'factor', documentation: 'Speed factor' }],
    }],
  },
  {
    name: 'inside',
    detail: 'Apply inside',
    documentation: 'Apply function inside a time span (speed up, apply, slow down)',
    signatures: [{
      label: 'inside(factor, function)',
      parameters: [
        { label: 'factor', documentation: 'Time compression factor' },
        { label: 'function', documentation: 'Function to apply' },
      ],
    }],
  },
  {
    name: 'outside',
    detail: 'Apply outside',
    documentation: 'Apply function outside a time span (slow down, apply, speed up)',
    signatures: [{
      label: 'outside(factor, function)',
      parameters: [
        { label: 'factor', documentation: 'Time expansion factor' },
        { label: 'function', documentation: 'Function to apply' },
      ],
    }],
  },
  {
    name: 'cpm',
    detail: 'Cycles per minute',
    documentation: 'Set pattern speed in cycles per minute',
    signatures: [{
      label: 'cpm(n)',
      parameters: [{ label: 'n', documentation: 'Cycles per minute' }],
    }],
  },
  {
    name: 'swing',
    detail: 'Swing feel',
    documentation: 'Apply swing timing to pattern',
    signatures: [{
      label: 'swing(amount)',
      parameters: [{ label: 'amount', documentation: 'Swing amount (0-1)' }],
    }],
  },
  {
    name: 'swingBy',
    detail: 'Swing by division',
    documentation: 'Apply swing at specific subdivision',
    signatures: [{
      label: 'swingBy(amount, division)',
      parameters: [
        { label: 'amount', documentation: 'Swing amount' },
        { label: 'division', documentation: 'Subdivision to swing' },
      ],
    }],
  },
  {
    name: 'hurry',
    detail: 'Hurry up',
    documentation: 'Speed up pattern and also speed up sample playback',
    signatures: [{
      label: 'hurry(factor)',
      parameters: [{ label: 'factor', documentation: 'Speed factor (affects both pattern and samples)' }],
    }],
  },
  // Signals (continuous patterns)
  {
    name: 'saw',
    detail: 'Sawtooth signal',
    documentation: 'Continuous sawtooth wave pattern (0 to 1 over each cycle)',
    signatures: [{
      label: 'saw',
      documentation: 'Use with .range() to set output range: saw.range(0, 100)',
      parameters: [],
    }],
  },
  {
    name: 'sine',
    detail: 'Sine signal',
    documentation: 'Continuous sine wave pattern (oscillates 0 to 1)',
    signatures: [{
      label: 'sine',
      documentation: 'Use with .range() to set output range: sine.range(200, 2000)',
      parameters: [],
    }],
  },
  {
    name: 'cosine',
    detail: 'Cosine signal',
    documentation: 'Continuous cosine wave pattern (like sine but phase-shifted)',
    signatures: [{
      label: 'cosine',
      documentation: 'Use with .range() to set output range: cosine.range(0, 1)',
      parameters: [],
    }],
  },
  {
    name: 'tri',
    detail: 'Triangle signal',
    documentation: 'Continuous triangle wave pattern',
    signatures: [{
      label: 'tri',
      documentation: 'Use with .range() to set output range: tri.range(0, 1)',
      parameters: [],
    }],
  },
  {
    name: 'square',
    detail: 'Square signal',
    documentation: 'Continuous square wave pattern (alternates between 0 and 1)',
    signatures: [{
      label: 'square',
      documentation: 'Use with .range() to set output range: square.range(0, 1)',
      parameters: [],
    }],
  },
  {
    name: 'rand',
    detail: 'Random signal',
    documentation: 'Continuous random pattern (new random value each cycle)',
    signatures: [{
      label: 'rand',
      documentation: 'Use with .range() to set output range: rand.range(0, 100)',
      parameters: [],
    }],
  },
  {
    name: 'perlin',
    detail: 'Perlin noise',
    documentation: 'Smooth continuous random pattern using Perlin noise',
    signatures: [{
      label: 'perlin',
      documentation: 'Use with .range() to set output range: perlin.range(0, 1)',
      parameters: [],
    }],
  },
  {
    name: 'irand',
    detail: 'Integer random',
    documentation: 'Random integer pattern',
    signatures: [{
      label: 'irand(max)',
      parameters: [{ label: 'max', documentation: 'Maximum value (exclusive)' }],
    }],
  },
  {
    name: 'brand',
    detail: 'Binary random',
    documentation: 'Random binary pattern (0 or 1)',
    signatures: [{
      label: 'brand',
      parameters: [],
    }],
  },
  // Random modifiers
  {
    name: 'choose',
    detail: 'Choose random',
    documentation: 'Randomly choose from a list of values each cycle',
    signatures: [{
      label: 'choose(values...)',
      parameters: [{ label: 'values', documentation: 'Values to choose from' }],
    }, {
      label: 'choose([values])',
      parameters: [{ label: 'values', documentation: 'Array of values to choose from' }],
    }],
  },
  {
    name: 'wchoose',
    detail: 'Weighted choose',
    documentation: 'Randomly choose with weights',
    signatures: [{
      label: 'wchoose([[value, weight], ...])',
      parameters: [{ label: 'pairs', documentation: 'Array of [value, weight] pairs' }],
    }],
  },
  {
    name: 'chooseCycles',
    detail: 'Choose for N cycles',
    documentation: 'Choose a random value and keep it for N cycles',
    signatures: [{
      label: 'chooseCycles(n, values...)',
      parameters: [
        { label: 'n', documentation: 'Number of cycles to keep the choice' },
        { label: 'values', documentation: 'Values to choose from' },
      ],
    }],
  },
  {
    name: 'degradeBy',
    detail: 'Degrade by amount',
    documentation: 'Randomly remove events with given probability',
    signatures: [{
      label: 'degradeBy(amount)',
      parameters: [{ label: 'amount', documentation: 'Probability of removing each event (0-1)' }],
    }],
  },
  {
    name: 'degrade',
    detail: 'Degrade 50%',
    documentation: 'Randomly remove 50% of events',
    signatures: [{
      label: 'degrade()',
      parameters: [],
    }],
  },
  {
    name: 'undegradeBy',
    detail: 'Undegrade by amount',
    documentation: 'Randomly keep events with given probability (opposite of degradeBy)',
    signatures: [{
      label: 'undegradeBy(amount)',
      parameters: [{ label: 'amount', documentation: 'Probability of keeping each event (0-1)' }],
    }],
  },
  {
    name: 'sometimesBy',
    detail: 'Sometimes by amount',
    documentation: 'Apply function with given probability',
    signatures: [{
      label: 'sometimesBy(amount, function)',
      parameters: [
        { label: 'amount', documentation: 'Probability (0-1)' },
        { label: 'function', documentation: 'Function to sometimes apply' },
      ],
    }],
  },
  {
    name: 'someCycles',
    detail: 'Some cycles',
    documentation: 'Apply function on some cycles (50% probability per cycle)',
    signatures: [{
      label: 'someCycles(function)',
      parameters: [{ label: 'function', documentation: 'Function to apply on some cycles' }],
    }],
  },
  {
    name: 'someCyclesBy',
    detail: 'Some cycles by amount',
    documentation: 'Apply function on some cycles with given probability',
    signatures: [{
      label: 'someCyclesBy(amount, function)',
      parameters: [
        { label: 'amount', documentation: 'Probability per cycle (0-1)' },
        { label: 'function', documentation: 'Function to apply' },
      ],
    }],
  },
  {
    name: 'never',
    detail: 'Never apply',
    documentation: 'Never apply the function (0% probability)',
    signatures: [{
      label: 'never(function)',
      parameters: [{ label: 'function', documentation: 'Function to never apply' }],
    }],
  },
  {
    name: 'always',
    detail: 'Always apply',
    documentation: 'Always apply the function (100% probability)',
    signatures: [{
      label: 'always(function)',
      parameters: [{ label: 'function', documentation: 'Function to always apply' }],
    }],
  },
  // Pattern factories
  {
    name: 'seq',
    detail: 'Sequence',
    documentation: 'Alias for cat - play patterns in sequence',
    signatures: [{
      label: 'seq(pattern1, pattern2, ...)',
      parameters: [{ label: 'patterns', documentation: 'Patterns to play in sequence' }],
    }],
  },
  {
    name: 'silence',
    detail: 'Silence',
    documentation: 'A silent pattern - produces no events',
    signatures: [{
      label: 'silence',
      parameters: [],
    }],
  },
  {
    name: 'run',
    detail: 'Run sequence',
    documentation: 'Create a pattern of numbers from 0 to n-1',
    signatures: [{
      label: 'run(n)',
      parameters: [{ label: 'n', documentation: 'Number of steps (0 to n-1)' }],
    }],
  },
  {
    name: 'arrange',
    detail: 'Arrange patterns',
    documentation: 'Arrange patterns over multiple cycles',
    signatures: [{
      label: 'arrange([cycles, pattern], ...)',
      parameters: [{ label: 'pairs', documentation: 'Array of [numCycles, pattern] pairs' }],
    }],
  },
  {
    name: 'polymeter',
    detail: 'Polymeter',
    documentation: 'Play patterns with different lengths simultaneously',
    signatures: [{
      label: 'polymeter(pattern1, pattern2, ...)',
      parameters: [{ label: 'patterns', documentation: 'Patterns of different lengths' }],
    }],
  },
  {
    name: 'polymeterSteps',
    detail: 'Polymeter with steps',
    documentation: 'Polymeter with specified step counts',
    signatures: [{
      label: 'polymeterSteps(steps, pattern1, pattern2, ...)',
      parameters: [
        { label: 'steps', documentation: 'Number of steps per cycle' },
        { label: 'patterns', documentation: 'Patterns to polymetrically combine' },
      ],
    }],
  },
  {
    name: 'binary',
    detail: 'Binary pattern',
    documentation: 'Create pattern from binary number',
    signatures: [{
      label: 'binary(n)',
      parameters: [{ label: 'n', documentation: 'Number to convert to binary pattern' }],
    }],
  },
  {
    name: 'binaryN',
    detail: 'Binary with length',
    documentation: 'Create pattern from binary number with specified length',
    signatures: [{
      label: 'binaryN(bits, n)',
      parameters: [
        { label: 'bits', documentation: 'Number of bits (pattern length)' },
        { label: 'n', documentation: 'Number to convert' },
      ],
    }],
  },
  // Tonal functions
  {
    name: 'transpose',
    detail: 'Transpose',
    documentation: 'Transpose notes by semitones',
    signatures: [{
      label: 'transpose(semitones)',
      parameters: [{ label: 'semitones', documentation: 'Number of semitones to transpose' }],
    }],
  },
  {
    name: 'scaleTranspose',
    detail: 'Scale transpose',
    documentation: 'Transpose within the current scale',
    signatures: [{
      label: 'scaleTranspose(steps)',
      parameters: [{ label: 'steps', documentation: 'Number of scale steps to transpose' }],
    }],
  },
  {
    name: 'rootNotes',
    detail: 'Root notes',
    documentation: 'Get root notes of chords',
    signatures: [{
      label: 'rootNotes(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern of chord names' }],
    }],
  },
  {
    name: 'chord',
    detail: 'Chord',
    documentation: 'Play a chord by name',
    signatures: [{
      label: 'chord(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern of chord names, e.g., "C Am F G" or "Cm7 Fmaj7"' }],
    }],
  },
  {
    name: 'mode',
    detail: 'Scale mode',
    documentation: 'Set the scale mode for note interpretation',
    signatures: [{
      label: 'mode(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern of mode names, e.g., "major minor dorian"' }],
    }],
  },
  {
    name: 'voicing',
    detail: 'Chord voicing',
    documentation: 'Set chord voicing style',
    signatures: [{
      label: 'voicing(style)',
      parameters: [{ label: 'style', documentation: 'Voicing style, e.g., "default", "lefthand", "open", "drop2"' }],
    }],
  },
  {
    name: 'voicings',
    detail: 'Chord voicings',
    documentation: 'Define custom chord voicings',
    signatures: [{
      label: 'voicings(dictionary)',
      parameters: [{ label: 'dictionary', documentation: 'Voicing dictionary object' }],
    }],
  },
  {
    name: 'anchor',
    detail: 'Voicing anchor',
    documentation: 'Set the anchor note for chord voicings',
    signatures: [{
      label: 'anchor(note)',
      parameters: [{ label: 'note', documentation: 'Anchor note, e.g., "c3"' }],
    }],
  },
  {
    name: 'octave',
    detail: 'Octave',
    documentation: 'Set the octave for notes',
    signatures: [{
      label: 'octave(n)',
      parameters: [{ label: 'n', documentation: 'Octave number (e.g., 3, 4, 5)' }],
    }],
  },
  // More effects
  {
    name: 'distort',
    detail: 'Distortion',
    documentation: 'Apply distortion effect',
    signatures: [{
      label: 'distort(amount)',
      parameters: [{ label: 'amount', documentation: 'Distortion amount (0-1)' }],
    }],
  },
  {
    name: 'shape',
    detail: 'Wave shaping',
    documentation: 'Apply wave shaping distortion',
    signatures: [{
      label: 'shape(amount)',
      parameters: [{ label: 'amount', documentation: 'Shaping amount (0-1)' }],
    }],
  },
  {
    name: 'tremolo',
    detail: 'Tremolo',
    documentation: 'Apply tremolo (amplitude modulation) effect',
    signatures: [{
      label: 'tremolo(depth, rate)',
      parameters: [
        { label: 'depth', documentation: 'Tremolo depth (0-1)' },
        { label: 'rate', documentation: 'Tremolo rate in Hz' },
      ],
    }],
  },
  {
    name: 'phaser',
    detail: 'Phaser',
    documentation: 'Apply phaser effect',
    signatures: [{
      label: 'phaser(depth, rate)',
      parameters: [
        { label: 'depth', documentation: 'Phaser depth (0-1)' },
        { label: 'rate', documentation: 'Phaser rate' },
      ],
    }],
  },
  {
    name: 'squiz',
    detail: 'Squiz',
    documentation: 'Apply squiz effect (pitch-based distortion)',
    signatures: [{
      label: 'squiz(amount)',
      parameters: [{ label: 'amount', documentation: 'Squiz amount' }],
    }],
  },
  {
    name: 'waveloss',
    detail: 'Wave loss',
    documentation: 'Drop samples for lo-fi effect',
    signatures: [{
      label: 'waveloss(amount)',
      parameters: [{ label: 'amount', documentation: 'Amount of samples to drop' }],
    }],
  },
  {
    name: 'delaytime',
    detail: 'Delay time',
    documentation: 'Set delay time',
    signatures: [{
      label: 'delaytime(time)',
      parameters: [{ label: 'time', documentation: 'Delay time in cycles' }],
    }],
  },
  {
    name: 'delayfeedback',
    detail: 'Delay feedback',
    documentation: 'Set delay feedback amount',
    signatures: [{
      label: 'delayfeedback(amount)',
      parameters: [{ label: 'amount', documentation: 'Feedback amount (0-1)' }],
    }],
  },
  {
    name: 'size',
    detail: 'Reverb size',
    documentation: 'Set reverb room size',
    signatures: [{
      label: 'size(amount)',
      parameters: [{ label: 'amount', documentation: 'Room size (0-1)' }],
    }],
  },
  {
    name: 'velocity',
    detail: 'Velocity',
    documentation: 'Set note velocity (for MIDI/instruments)',
    signatures: [{
      label: 'velocity(amount)',
      parameters: [{ label: 'amount', documentation: 'Velocity (0-1)' }],
    }],
  },
  {
    name: 'amp',
    detail: 'Amplitude',
    documentation: 'Set amplitude (alias for gain)',
    signatures: [{
      label: 'amp(amount)',
      parameters: [{ label: 'amount', documentation: 'Amplitude level' }],
    }],
  },
  // More utility functions
  {
    name: 'range',
    detail: 'Range',
    documentation: 'Map pattern values to a range',
    signatures: [{
      label: 'range(min, max)',
      parameters: [
        { label: 'min', documentation: 'Minimum output value' },
        { label: 'max', documentation: 'Maximum output value' },
      ],
    }],
  },
  {
    name: 'cps',
    detail: 'Get/set CPS',
    documentation: 'Get or set cycles per second as a pattern',
    signatures: [{
      label: 'cps(value)',
      parameters: [{ label: 'value', documentation: 'Cycles per second' }],
    }],
  },
  {
    name: 'off',
    detail: 'Off',
    documentation: 'Layer a time-shifted and modified copy of the pattern',
    signatures: [{
      label: 'off(amount, function)',
      parameters: [
        { label: 'amount', documentation: 'Time offset' },
        { label: 'function', documentation: 'Function to apply to offset copy' },
      ],
    }],
  },
  {
    name: 'layer',
    detail: 'Layer',
    documentation: 'Layer multiple functions over the pattern',
    signatures: [{
      label: 'layer(function1, function2, ...)',
      parameters: [{ label: 'functions', documentation: 'Functions to layer' }],
    }],
  },
  {
    name: 'superimpose',
    detail: 'Superimpose',
    documentation: 'Play pattern with a modified copy on top',
    signatures: [{
      label: 'superimpose(function)',
      parameters: [{ label: 'function', documentation: 'Function to apply to superimposed copy' }],
    }],
  },
  {
    name: 'stut',
    detail: 'Stutter',
    documentation: 'Stutter effect - repeat with decay',
    signatures: [{
      label: 'stut(times, decay, time)',
      parameters: [
        { label: 'times', documentation: 'Number of repeats' },
        { label: 'decay', documentation: 'Volume decay per repeat' },
        { label: 'time', documentation: 'Time between repeats' },
      ],
    }],
  },
  {
    name: 'echo',
    detail: 'Echo',
    documentation: 'Echo effect - repeat with delay',
    signatures: [{
      label: 'echo(times, time, feedback)',
      parameters: [
        { label: 'times', documentation: 'Number of echoes' },
        { label: 'time', documentation: 'Delay time' },
        { label: 'feedback', documentation: 'Feedback amount' },
      ],
    }],
  },
  {
    name: 'when',
    detail: 'When',
    documentation: 'Apply function when condition is true',
    signatures: [{
      label: 'when(condition, function)',
      parameters: [
        { label: 'condition', documentation: 'Boolean pattern or function' },
        { label: 'function', documentation: 'Function to apply when true' },
      ],
    }],
  },
  {
    name: 'while',
    detail: 'While',
    documentation: 'Play pattern while condition is true, otherwise silence',
    signatures: [{
      label: 'while(condition)',
      parameters: [{ label: 'condition', documentation: 'Boolean pattern' }],
    }],
  },
  {
    name: 'firstOf',
    detail: 'First of N',
    documentation: 'Apply function only on the first of every N cycles',
    signatures: [{
      label: 'firstOf(n, function)',
      parameters: [
        { label: 'n', documentation: 'Cycle interval' },
        { label: 'function', documentation: 'Function to apply on first cycle' },
      ],
    }],
  },
  {
    name: 'lastOf',
    detail: 'Last of N',
    documentation: 'Apply function only on the last of every N cycles',
    signatures: [{
      label: 'lastOf(n, function)',
      parameters: [
        { label: 'n', documentation: 'Cycle interval' },
        { label: 'function', documentation: 'Function to apply on last cycle' },
      ],
    }],
  },
  {
    name: 'chunk',
    detail: 'Chunk',
    documentation: 'Divide pattern into chunks and apply function to one chunk per cycle',
    signatures: [{
      label: 'chunk(n, function)',
      parameters: [
        { label: 'n', documentation: 'Number of chunks' },
        { label: 'function', documentation: 'Function to apply to current chunk' },
      ],
    }],
  },
  {
    name: 'arp',
    detail: 'Arpeggio',
    documentation: 'Arpeggiate chords',
    signatures: [{
      label: 'arp(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Arpeggio pattern (e.g., "up", "down", "updown")' }],
    }],
  },
  // Pattern combinators
  {
    name: 'fastcat',
    detail: 'Fast concatenate',
    documentation: 'Concatenate patterns, each taking one cycle (alias for cat)',
    signatures: [{
      label: 'fastcat(pattern1, pattern2, ...)',
      parameters: [{ label: 'patterns', documentation: 'Patterns to concatenate' }],
    }],
  },
  {
    name: 'slowcat',
    detail: 'Slow concatenate',
    documentation: 'Concatenate patterns, each pattern plays for one cycle in sequence',
    signatures: [{
      label: 'slowcat(pattern1, pattern2, ...)',
      parameters: [{ label: 'patterns', documentation: 'Patterns to concatenate' }],
    }],
  },
  {
    name: 'randcat',
    detail: 'Random concatenate',
    documentation: 'Randomly choose between patterns each cycle',
    signatures: [{
      label: 'randcat(pattern1, pattern2, ...)',
      parameters: [{ label: 'patterns', documentation: 'Patterns to randomly choose from' }],
    }],
  },
  {
    name: 'pure',
    detail: 'Pure value',
    documentation: 'Create a pattern from a single value',
    signatures: [{
      label: 'pure(value)',
      parameters: [{ label: 'value', documentation: 'Value to create pattern from' }],
    }],
  },
  {
    name: 'reify',
    detail: 'Reify pattern',
    documentation: 'Convert a value to a pattern if it is not already',
    signatures: [{
      label: 'reify(value)',
      parameters: [{ label: 'value', documentation: 'Value or pattern' }],
    }],
  },
  // Math operations
  {
    name: 'add',
    detail: 'Add',
    documentation: 'Add a value or pattern to the current pattern',
    signatures: [{
      label: 'add(value)',
      parameters: [{ label: 'value', documentation: 'Value to add' }],
    }],
  },
  {
    name: 'sub',
    detail: 'Subtract',
    documentation: 'Subtract a value or pattern from the current pattern',
    signatures: [{
      label: 'sub(value)',
      parameters: [{ label: 'value', documentation: 'Value to subtract' }],
    }],
  },
  {
    name: 'mul',
    detail: 'Multiply',
    documentation: 'Multiply the current pattern by a value or pattern',
    signatures: [{
      label: 'mul(value)',
      parameters: [{ label: 'value', documentation: 'Value to multiply by' }],
    }],
  },
  {
    name: 'div',
    detail: 'Divide',
    documentation: 'Divide the current pattern by a value or pattern',
    signatures: [{
      label: 'div(value)',
      parameters: [{ label: 'value', documentation: 'Value to divide by' }],
    }],
  },
  // Juxtapose variations
  {
    name: 'juxBy',
    detail: 'Juxtapose by amount',
    documentation: 'Apply function to right channel with adjustable stereo width',
    signatures: [{
      label: 'juxBy(amount, function)',
      parameters: [
        { label: 'amount', documentation: 'Stereo width (0-1, 0.5 = half width)' },
        { label: 'function', documentation: 'Function to apply to right channel' },
      ],
    }],
  },
  // Envelope shortcuts
  {
    name: 'ad',
    detail: 'Attack-Decay envelope',
    documentation: 'Set attack and decay times',
    signatures: [{
      label: 'ad(attack, decay)',
      parameters: [
        { label: 'attack', documentation: 'Attack time in seconds' },
        { label: 'decay', documentation: 'Decay time in seconds' },
      ],
    }],
  },
  {
    name: 'adsr',
    detail: 'ADSR envelope',
    documentation: 'Set full ADSR envelope',
    signatures: [{
      label: 'adsr(attack, decay, sustain, release)',
      parameters: [
        { label: 'attack', documentation: 'Attack time' },
        { label: 'decay', documentation: 'Decay time' },
        { label: 'sustain', documentation: 'Sustain level (0-1)' },
        { label: 'release', documentation: 'Release time' },
      ],
    }],
  },
  {
    name: 'ar',
    detail: 'Attack-Release envelope',
    documentation: 'Set attack and release times (no sustain)',
    signatures: [{
      label: 'ar(attack, release)',
      parameters: [
        { label: 'attack', documentation: 'Attack time in seconds' },
        { label: 'release', documentation: 'Release time in seconds' },
      ],
    }],
  },
  // Duration and timing
  {
    name: 'dur',
    detail: 'Duration',
    documentation: 'Set event duration in cycles',
    signatures: [{
      label: 'dur(cycles)',
      parameters: [{ label: 'cycles', documentation: 'Duration in cycles' }],
    }],
  },
  {
    name: 'legato',
    detail: 'Legato',
    documentation: 'Set note legato (overlap/gap between notes)',
    signatures: [{
      label: 'legato(value)',
      parameters: [{ label: 'value', documentation: 'Legato value (1 = full duration, <1 = gap, >1 = overlap)' }],
    }],
  },
  {
    name: 'nudge',
    detail: 'Nudge timing',
    documentation: 'Shift events in time by a small amount',
    signatures: [{
      label: 'nudge(seconds)',
      parameters: [{ label: 'seconds', documentation: 'Time offset in seconds' }],
    }],
  },
  {
    name: 'unit',
    detail: 'Time unit',
    documentation: 'Set the time unit for speed calculations',
    signatures: [{
      label: 'unit(type)',
      parameters: [{ label: 'type', documentation: 'Unit type: "r" (rate), "c" (cycle), "s" (seconds)' }],
    }],
  },
  // Gate and hold
  {
    name: 'gate',
    detail: 'Gate',
    documentation: 'Set gate time (note on duration)',
    signatures: [{
      label: 'gate(value)',
      parameters: [{ label: 'value', documentation: 'Gate time (0-1)' }],
    }],
  },
  {
    name: 'hold',
    detail: 'Hold',
    documentation: 'Hold/sustain the sound',
    signatures: [{
      label: 'hold(value)',
      parameters: [{ label: 'value', documentation: 'Hold time' }],
    }],
  },
  // Synth parameters
  {
    name: 'freq',
    detail: 'Frequency',
    documentation: 'Set frequency in Hz directly',
    signatures: [{
      label: 'freq(hz)',
      parameters: [{ label: 'hz', documentation: 'Frequency in Hz' }],
    }],
  },
  {
    name: 'noise',
    detail: 'Noise',
    documentation: 'Add noise to the sound',
    signatures: [{
      label: 'noise(amount)',
      parameters: [{ label: 'amount', documentation: 'Noise amount (0-1)' }],
    }],
  },
  {
    name: 'detune',
    detail: 'Detune',
    documentation: 'Detune the sound in semitones',
    signatures: [{
      label: 'detune(semitones)',
      parameters: [{ label: 'semitones', documentation: 'Detune amount in semitones' }],
    }],
  },
  {
    name: 'unison',
    detail: 'Unison',
    documentation: 'Add unison voices for thicker sound',
    signatures: [{
      label: 'unison(voices)',
      parameters: [{ label: 'voices', documentation: 'Number of unison voices' }],
    }],
  },
  // FM synthesis
  {
    name: 'fm',
    detail: 'FM amount',
    documentation: 'Set FM synthesis modulation amount',
    signatures: [{
      label: 'fm(amount)',
      parameters: [{ label: 'amount', documentation: 'FM modulation amount' }],
    }],
  },
  {
    name: 'fmi',
    detail: 'FM index',
    documentation: 'Set FM modulation index',
    signatures: [{
      label: 'fmi(index)',
      parameters: [{ label: 'index', documentation: 'FM modulation index' }],
    }],
  },
  {
    name: 'fmh',
    detail: 'FM harmonic',
    documentation: 'Set FM modulator harmonic ratio',
    signatures: [{
      label: 'fmh(ratio)',
      parameters: [{ label: 'ratio', documentation: 'Harmonic ratio of modulator' }],
    }],
  },
  // Vibrato
  {
    name: 'vib',
    detail: 'Vibrato',
    documentation: 'Add vibrato effect',
    signatures: [{
      label: 'vib(depth)',
      parameters: [{ label: 'depth', documentation: 'Vibrato depth' }],
    }],
  },
  {
    name: 'vibrato',
    detail: 'Vibrato (full)',
    documentation: 'Add vibrato with rate control',
    signatures: [{
      label: 'vibrato(depth, rate)',
      parameters: [
        { label: 'depth', documentation: 'Vibrato depth' },
        { label: 'rate', documentation: 'Vibrato rate in Hz' },
      ],
    }],
  },
  // Leslie effect
  {
    name: 'leslie',
    detail: 'Leslie speaker',
    documentation: 'Apply Leslie speaker effect (rotating speaker)',
    signatures: [{
      label: 'leslie(amount)',
      parameters: [{ label: 'amount', documentation: 'Leslie effect amount' }],
    }],
  },
  // Wavetable
  {
    name: 'wt',
    detail: 'Wavetable',
    documentation: 'Use wavetable synthesis',
    signatures: [{
      label: 'wt(table)',
      parameters: [{ label: 'table', documentation: 'Wavetable name or number' }],
    }],
  },
  // Pattern manipulation
  {
    name: 'within',
    detail: 'Within',
    documentation: 'Apply function to a portion of the pattern',
    signatures: [{
      label: 'within(start, end, function)',
      parameters: [
        { label: 'start', documentation: 'Start position (0-1)' },
        { label: 'end', documentation: 'End position (0-1)' },
        { label: 'function', documentation: 'Function to apply' },
      ],
    }],
  },
  {
    name: 'focus',
    detail: 'Focus',
    documentation: 'Focus on a portion of the pattern',
    signatures: [{
      label: 'focus(start, end)',
      parameters: [
        { label: 'start', documentation: 'Start position (0-1)' },
        { label: 'end', documentation: 'End position (0-1)' },
      ],
    }],
  },
  {
    name: 'contrast',
    detail: 'Contrast',
    documentation: 'Apply different functions based on a boolean pattern',
    signatures: [{
      label: 'contrast(trueFunc, falseFunc, boolPattern)',
      parameters: [
        { label: 'trueFunc', documentation: 'Function when true' },
        { label: 'falseFunc', documentation: 'Function when false' },
        { label: 'boolPattern', documentation: 'Boolean pattern' },
      ],
    }],
  },
  // Scramble and shuffle
  {
    name: 'scramble',
    detail: 'Scramble',
    documentation: 'Randomly rearrange pattern segments',
    signatures: [{
      label: 'scramble(n)',
      parameters: [{ label: 'n', documentation: 'Number of segments' }],
    }],
  },
  {
    name: 'shuffle',
    detail: 'Shuffle',
    documentation: 'Shuffle pattern segments (same random order each cycle)',
    signatures: [{
      label: 'shuffle(n)',
      parameters: [{ label: 'n', documentation: 'Number of segments' }],
    }],
  },
  {
    name: 'bite',
    detail: 'Bite',
    documentation: 'Slice and rearrange pattern segments',
    signatures: [{
      label: 'bite(n, pattern)',
      parameters: [
        { label: 'n', documentation: 'Number of segments' },
        { label: 'pattern', documentation: 'Pattern of segment indices' },
      ],
    }],
  },
  // Inhabit
  {
    name: 'inhabit',
    detail: 'Inhabit',
    documentation: 'Map pattern values to other patterns',
    signatures: [{
      label: 'inhabit(mapping)',
      parameters: [{ label: 'mapping', documentation: 'Object mapping values to patterns' }],
    }],
  },
  // Weave
  {
    name: 'weave',
    detail: 'Weave',
    documentation: 'Weave patterns together with time offsets',
    signatures: [{
      label: 'weave(subdivisions, patterns...)',
      parameters: [
        { label: 'subdivisions', documentation: 'Number of subdivisions' },
        { label: 'patterns', documentation: 'Patterns to weave' },
      ],
    }],
  },
  {
    name: 'weaveWith',
    detail: 'Weave with function',
    documentation: 'Weave with a function applied at each step',
    signatures: [{
      label: 'weaveWith(subdivisions, function, patterns...)',
      parameters: [
        { label: 'subdivisions', documentation: 'Number of subdivisions' },
        { label: 'function', documentation: 'Function to apply' },
        { label: 'patterns', documentation: 'Patterns to weave' },
      ],
    }],
  },
  // Spin and stripe
  {
    name: 'spin',
    detail: 'Spin',
    documentation: 'Layer pattern with itself, rotated in stereo',
    signatures: [{
      label: 'spin(n)',
      parameters: [{ label: 'n', documentation: 'Number of rotations' }],
    }],
  },
  {
    name: 'stripe',
    detail: 'Stripe',
    documentation: 'Apply function in stripes across the pattern',
    signatures: [{
      label: 'stripe(n)',
      parameters: [{ label: 'n', documentation: 'Number of stripes' }],
    }],
  },
  // Reset
  {
    name: 'reset',
    detail: 'Reset',
    documentation: 'Reset pattern when triggered',
    signatures: [{
      label: 'reset(trigger)',
      parameters: [{ label: 'trigger', documentation: 'Trigger pattern' }],
    }],
  },
  {
    name: 'resetCycles',
    detail: 'Reset cycles',
    documentation: 'Reset pattern after N cycles',
    signatures: [{
      label: 'resetCycles(n)',
      parameters: [{ label: 'n', documentation: 'Number of cycles before reset' }],
    }],
  },
  // Set
  {
    name: 'set',
    detail: 'Set',
    documentation: 'Set control values from an object pattern',
    signatures: [{
      label: 'set(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern of {control: value} objects' }],
    }],
  },
  // MIDI
  {
    name: 'ccn',
    detail: 'CC number',
    documentation: 'Set MIDI CC number',
    signatures: [{
      label: 'ccn(number)',
      parameters: [{ label: 'number', documentation: 'MIDI CC number (0-127)' }],
    }],
  },
  {
    name: 'ccv',
    detail: 'CC value',
    documentation: 'Set MIDI CC value',
    signatures: [{
      label: 'ccv(value)',
      parameters: [{ label: 'value', documentation: 'MIDI CC value (0-127)' }],
    }],
  },
  {
    name: 'midichan',
    detail: 'MIDI channel',
    documentation: 'Set MIDI channel',
    signatures: [{
      label: 'midichan(channel)',
      parameters: [{ label: 'channel', documentation: 'MIDI channel (0-15)' }],
    }],
  },
  {
    name: 'midiport',
    detail: 'MIDI port',
    documentation: 'Set MIDI output port',
    signatures: [{
      label: 'midiport(port)',
      parameters: [{ label: 'port', documentation: 'MIDI port name' }],
    }],
  },
  // Color/visualization
  {
    name: 'color',
    detail: 'Color',
    documentation: 'Set color for visualization',
    signatures: [{
      label: 'color(value)',
      parameters: [{ label: 'value', documentation: 'Color value (CSS color or pattern)' }],
    }],
  },
  // Utility
  {
    name: 'log',
    detail: 'Log',
    documentation: 'Log pattern values to console for debugging',
    signatures: [{
      label: 'log()',
      parameters: [],
    }],
  },
  {
    name: 'apply',
    detail: 'Apply',
    documentation: 'Apply a function to the pattern',
    signatures: [{
      label: 'apply(function)',
      parameters: [{ label: 'function', documentation: 'Function to apply' }],
    }],
  },
  {
    name: 'all',
    detail: 'All',
    documentation: 'Apply function to all events',
    signatures: [{
      label: 'all(function)',
      parameters: [{ label: 'function', documentation: 'Function to apply to all events' }],
    }],
  },
  // Press
  {
    name: 'press',
    detail: 'Press',
    documentation: 'Compress events to the first half of their timespan',
    signatures: [{
      label: 'press()',
      parameters: [],
    }],
  },
  {
    name: 'pressBy',
    detail: 'Press by',
    documentation: 'Compress events by a specified amount',
    signatures: [{
      label: 'pressBy(amount)',
      parameters: [{ label: 'amount', documentation: 'Compression amount (0-1)' }],
    }],
  },
  // Pick functions for sample selection
  {
    name: 'pickF',
    detail: 'Pick with function',
    documentation: 'Pick samples using a function',
    signatures: [{
      label: 'pickF(function)',
      parameters: [{ label: 'function', documentation: 'Function to determine sample selection' }],
    }],
  },
  {
    name: 'pickOut',
    detail: 'Pick out',
    documentation: 'Pick samples cycling through indices',
    signatures: [{
      label: 'pickOut(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern of sample indices' }],
    }],
  },
  {
    name: 'pickRestart',
    detail: 'Pick restart',
    documentation: 'Pick samples, restarting on each cycle',
    signatures: [{
      label: 'pickRestart()',
      parameters: [],
    }],
  },
  // Granular
  {
    name: 'granular',
    detail: 'Granular',
    documentation: 'Apply granular synthesis',
    signatures: [{
      label: 'granular(options)',
      parameters: [{ label: 'options', documentation: 'Granular synthesis options' }],
    }],
  },
  // === AUTO-GENERATED FROM STRUDEL JSDOC ===
  {
    name: 'wtenv',
    detail: 'Amount of envelope applied wavetable oscillator\'s position e',
    documentation: 'Amount of envelope applied wavetable oscillator\'s position envelope',
    signatures: [{
      label: 'wtenv(amount)',
      parameters: [
        { label: 'amount', documentation: 'between 0 and 1' }
      ],
    }],
  },
  {
    name: 'wtattack',
    detail: 'Attack time of the wavetable oscillator\'s position envelope',
    documentation: 'Attack time of the wavetable oscillator\'s position envelope',
    signatures: [{
      label: 'wtattack(time)',
      parameters: [
        { label: 'time', documentation: 'attack time in seconds' }
      ],
    }],
  },
  {
    name: 'wtdecay',
    detail: 'Decay time of the wavetable oscillator\'s position envelope',
    documentation: 'Decay time of the wavetable oscillator\'s position envelope',
    signatures: [{
      label: 'wtdecay(time)',
      parameters: [
        { label: 'time', documentation: 'decay time in seconds' }
      ],
    }],
  },
  {
    name: 'wtsustain',
    detail: 'Sustain time of the wavetable oscillator\'s position envelope',
    documentation: 'Sustain time of the wavetable oscillator\'s position envelope',
    signatures: [{
      label: 'wtsustain(gain)',
      parameters: [
        { label: 'gain', documentation: 'sustain level (0 to 1)' }
      ],
    }],
  },
  {
    name: 'wtrelease',
    detail: 'Release time of the wavetable oscillator\'s position envelope',
    documentation: 'Release time of the wavetable oscillator\'s position envelope',
    signatures: [{
      label: 'wtrelease(time)',
      parameters: [
        { label: 'time', documentation: 'release time in seconds' }
      ],
    }],
  },
  {
    name: 'wtrate',
    detail: 'Rate of the LFO for the wavetable oscillator\'s position',
    documentation: 'Rate of the LFO for the wavetable oscillator\'s position',
    signatures: [{
      label: 'wtrate(rate)',
      parameters: [
        { label: 'rate', documentation: 'rate in hertz' }
      ],
    }],
  },
  {
    name: 'wtsync',
    detail: 'cycle synced rate of the LFO for the wavetable oscillator\'s ',
    documentation: 'cycle synced rate of the LFO for the wavetable oscillator\'s position',
    signatures: [{
      label: 'wtsync(rate)',
      parameters: [
        { label: 'rate', documentation: 'rate in cycles' }
      ],
    }],
  },
  {
    name: 'wtdepth',
    detail: 'Depth of the LFO for the wavetable oscillator\'s position',
    documentation: 'Depth of the LFO for the wavetable oscillator\'s position',
    signatures: [{
      label: 'wtdepth(depth)',
      parameters: [
        { label: 'depth', documentation: 'depth of modulation' }
      ],
    }],
  },
  {
    name: 'wtshape',
    detail: 'Shape of the LFO for the wavetable oscillator\'s position',
    documentation: 'Shape of the LFO for the wavetable oscillator\'s position',
    signatures: [{
      label: 'wtshape(shape)',
      parameters: [
        { label: 'shape', documentation: 'Shape of the lfo (0, 1, 2, ..)' }
      ],
    }],
  },
  {
    name: 'wtdc',
    detail: 'DC offset of the LFO for the wavetable oscillator\'s position',
    documentation: 'DC offset of the LFO for the wavetable oscillator\'s position',
    signatures: [{
      label: 'wtdc(dcoffset)',
      parameters: [
        { label: 'dcoffset', documentation: 'dc offset. set to 0 for unipolar' }
      ],
    }],
  },
  {
    name: 'wtskew',
    detail: 'Skew of the LFO for the wavetable oscillator\'s position',
    documentation: 'Skew of the LFO for the wavetable oscillator\'s position',
    signatures: [{
      label: 'wtskew(skew)',
      parameters: [
        { label: 'skew', documentation: 'How much to bend the LFO shape' }
      ],
    }],
  },
  {
    name: 'warp',
    detail: 'Amount of warp (alteration of the waveform) to apply to the ',
    documentation: 'Amount of warp (alteration of the waveform) to apply to the wavetable oscillator .',
    signatures: [{
      label: 'warp(amount)',
      parameters: [
        { label: 'amount', documentation: 'Warp of the wavetable from 0 to 1' }
      ],
    }],
  },
  {
    name: 'warpattack',
    detail: 'Attack time of the wavetable oscillator\'s warp envelope',
    documentation: 'Attack time of the wavetable oscillator\'s warp envelope',
    signatures: [{
      label: 'warpattack(time)',
      parameters: [
        { label: 'time', documentation: 'attack time in seconds' }
      ],
    }],
  },
  {
    name: 'warpdecay',
    detail: 'Decay time of the wavetable oscillator\'s warp envelope',
    documentation: 'Decay time of the wavetable oscillator\'s warp envelope',
    signatures: [{
      label: 'warpdecay(time)',
      parameters: [
        { label: 'time', documentation: 'decay time in seconds' }
      ],
    }],
  },
  {
    name: 'warpsustain',
    detail: 'Sustain time of the wavetable oscillator\'s warp envelope',
    documentation: 'Sustain time of the wavetable oscillator\'s warp envelope',
    signatures: [{
      label: 'warpsustain(gain)',
      parameters: [
        { label: 'gain', documentation: 'sustain level (0 to 1)' }
      ],
    }],
  },
  {
    name: 'warprelease',
    detail: 'Release time of the wavetable oscillator\'s warp envelope',
    documentation: 'Release time of the wavetable oscillator\'s warp envelope',
    signatures: [{
      label: 'warprelease(time)',
      parameters: [
        { label: 'time', documentation: 'release time in seconds' }
      ],
    }],
  },
  {
    name: 'warprate',
    detail: 'Rate of the LFO for the wavetable oscillator\'s warp',
    documentation: 'Rate of the LFO for the wavetable oscillator\'s warp',
    signatures: [{
      label: 'warprate(rate)',
      parameters: [
        { label: 'rate', documentation: 'rate in hertz' }
      ],
    }],
  },
  {
    name: 'warpdepth',
    detail: 'Depth of the LFO for the wavetable oscillator\'s warp',
    documentation: 'Depth of the LFO for the wavetable oscillator\'s warp',
    signatures: [{
      label: 'warpdepth(depth)',
      parameters: [
        { label: 'depth', documentation: 'depth of modulation' }
      ],
    }],
  },
  {
    name: 'warpshape',
    detail: 'Shape of the LFO for the wavetable oscillator\'s warp',
    documentation: 'Shape of the LFO for the wavetable oscillator\'s warp',
    signatures: [{
      label: 'warpshape(shape)',
      parameters: [
        { label: 'shape', documentation: 'Shape of the lfo (0, 1, 2, ..)' }
      ],
    }],
  },
  {
    name: 'warpdc',
    detail: 'DC offset of the LFO for the wavetable oscillator\'s warp',
    documentation: 'DC offset of the LFO for the wavetable oscillator\'s warp',
    signatures: [{
      label: 'warpdc(dcoffset)',
      parameters: [
        { label: 'dcoffset', documentation: 'dc offset. set to 0 for unipolar' }
      ],
    }],
  },
  {
    name: 'warpskew',
    detail: 'Skew of the LFO for the wavetable oscillator\'s warp',
    documentation: 'Skew of the LFO for the wavetable oscillator\'s warp',
    signatures: [{
      label: 'warpskew(skew)',
      parameters: [
        { label: 'skew', documentation: 'How much to bend the LFO shape' }
      ],
    }],
  },
  {
    name: 'warpmode',
    detail: 'Type of warp (alteration of the waveform) to apply to the wa',
    documentation: 'Type of warp (alteration of the waveform) to apply to the wavetable oscillator. The current options are: none, asym, bendp, bendm, bendmp, sync, quant, fold, pwm, orbit, spin, chaos, primes, binary, brownian, reciprocal, wormhole, logistic, sigmoid, fractal, flip .',
    signatures: [{
      label: 'warpmode(mode)',
      parameters: [
        { label: 'mode', documentation: 'Warp mode' }
      ],
    }],
  },
  {
    name: 'wtphaserand',
    detail: 'Amount of randomness of the initial phase of the wavetable o',
    documentation: 'Amount of randomness of the initial phase of the wavetable oscillator.',
    signatures: [{
      label: 'wtphaserand(amount)',
      parameters: [
        { label: 'amount', documentation: 'Randomness of the initial phase. Between 0 (not random) and 1 (fully random)' }
      ],
    }],
  },
  {
    name: 'warpenv',
    detail: 'Amount of envelope applied wavetable oscillator\'s position e',
    documentation: 'Amount of envelope applied wavetable oscillator\'s position envelope',
    signatures: [{
      label: 'warpenv(amount)',
      parameters: [
        { label: 'amount', documentation: 'between 0 and 1' }
      ],
    }],
  },
  {
    name: 'warpsync',
    detail: 'cycle synced rate of the LFO for the wavetable warp position',
    documentation: 'cycle synced rate of the LFO for the wavetable warp position',
    signatures: [{
      label: 'warpsync(rate)',
      parameters: [
        { label: 'rate', documentation: 'rate in cycles' }
      ],
    }],
  },
  {
    name: 'source',
    detail: 'Define a custom webaudio node to use as a sound source',
    documentation: 'Define a custom webaudio node to use as a sound source.',
    signatures: [{
      label: 'source(getSource)',
      parameters: [
        { label: 'getSource', documentation: '* @synonyms src' }
      ],
    }],
  },
  {
    name: 'accelerate',
    detail: 'A pattern of numbers that speed up (or slow down) samples wh',
    documentation: 'A pattern of numbers that speed up (or slow down) samples while they play. Currently only supported by osc / superdirt.',
    signatures: [{
      label: 'accelerate(amount)',
      parameters: [
        { label: 'amount', documentation: 'acceleration.' }
      ],
    }],
  },
  {
    name: 'postgain',
    detail: 'Gain applied after all effects have been processed',
    documentation: 'Gain applied after all effects have been processed. .',
    signatures: [{
      label: 'postgain()',
      parameters: [

      ],
    }],
  },
  {
    name: 'fmenv',
    detail: 'Ramp type of fm envelope',
    documentation: 'Ramp type of fm envelope. Exp might be a bit broken.. . . . . ._',
    signatures: [{
      label: 'fmenv(type)',
      parameters: [
        { label: 'type', documentation: 'lin | exp' }
      ],
    }],
  },
  {
    name: 'fmattack',
    detail: 'Attack time for the FM envelope: time it takes to reach maxi',
    documentation: 'Attack time for the FM envelope: time it takes to reach maximum modulation . . ._',
    signatures: [{
      label: 'fmattack(time)',
      parameters: [
        { label: 'time', documentation: 'attack time' }
      ],
    }],
  },
  {
    name: 'fmwave',
    detail: 'Waveform of the fm modulator)',
    documentation: 'Waveform of the fm modulator).).',
    signatures: [{
      label: 'fmwave(wave)',
      parameters: [
        { label: 'wave', documentation: 'waveform' }
      ],
    }],
  },
  {
    name: 'fmdecay',
    detail: 'Decay time for the FM envelope: seconds until the sustain le',
    documentation: 'Decay time for the FM envelope: seconds until the sustain level is reached after the attack phase. . . . ._',
    signatures: [{
      label: 'fmdecay(time)',
      parameters: [
        { label: 'time', documentation: 'decay time' }
      ],
    }],
  },
  {
    name: 'fmsustain',
    detail: 'Sustain level for the FM envelope: how much modulation is ap',
    documentation: 'Sustain level for the FM envelope: how much modulation is applied after the decay phase . . . ._',
    signatures: [{
      label: 'fmsustain(level)',
      parameters: [
        { label: 'level', documentation: 'sustain level' }
      ],
    }],
  },
  {
    name: 'chorus',
    detail: 'mix control for the chorus effect',
    documentation: 'mix control for the chorus effect',
    signatures: [{
      label: 'chorus(chorus)',
      parameters: [
        { label: 'chorus', documentation: 'mix amount between 0 and 1' }
      ],
    }],
  },
  {
    name: 'bpq',
    detail: 'Sets the **b**and-**p**ass **q**-factor (resonance)',
    documentation: 'Sets the **b**and-**p**ass **q**-factor (resonance). / // currently an alias of \'bandq\' https://codeberg.org/uzu/strudel/issues/496 // [\'bpq\'], export const { bandq, bpq } =; /** A pattern of numbers from 0 to 1. Skips the beginning of each sample, e.g. `0.25` to cut off the first quarter from each sample.',
    signatures: [{
      label: 'bpq(q, amount)',
      parameters: [
        { label: 'q', documentation: 'q factor' },
        { label: 'amount', documentation: 'between 0 and 1, where 1 is the length of the sample' }
      ],
    }],
  },
  {
    name: 'loop',
    detail: 'Loops the sample',
    documentation: 'Loops the sample. Note that the tempo of the loop is not synced with the cycle tempo. To change the loop region, use loopBegin / loopEnd.',
    signatures: [{
      label: 'loop(on)',
      parameters: [
        { label: 'on', documentation: 'If 1, the sample is looped' }
      ],
    }],
  },
  {
    name: 'loopBegin',
    detail: 'Begin to loop at a specific point in the sample (inbetween `',
    documentation: 'Begin to loop at a specific point in the sample (inbetween `begin` and `end`). Note that the loop point must be inbetween `begin` and `end`, and before `loopEnd`! Note: Samples starting with wt_ will automatically loop! (wt = wavetable) .._',
    signatures: [{
      label: 'loopBegin(time)',
      parameters: [
        { label: 'time', documentation: 'between 0 and 1, where 1 is the length of the sample' }
      ],
    }],
  },
  {
    name: 'loopEnd',
    detail: 'End the looping section at a specific point in the sample (i',
    documentation: 'End the looping section at a specific point in the sample (inbetween `begin` and `end`). Note that the loop point must be inbetween `begin` and `end`, and after `loopBegin`! .._',
    signatures: [{
      label: 'loopEnd(time)',
      parameters: [
        { label: 'time', documentation: 'between 0 and 1, where 1 is the length of the sample' }
      ],
    }],
  },
  {
    name: 'tremolosync',
    detail: 'Modulate the amplitude of a sound with a continuous waveform',
    documentation: 'Modulate the amplitude of a sound with a continuous waveform).',
    signatures: [{
      label: 'tremolosync(cycles)',
      parameters: [
        { label: 'cycles', documentation: 'modulation speed in cycles' }
      ],
    }],
  },
  {
    name: 'tremolodepth',
    detail: 'Depth of amplitude modulation)',
    documentation: 'Depth of amplitude modulation).',
    signatures: [{
      label: 'tremolodepth(depth)',
      parameters: [
        { label: 'depth', documentation: '* @example' }
      ],
    }],
  },
  {
    name: 'tremoloskew',
    detail: 'Alter the shape of the modulation waveform',
    documentation: 'Alter the shape of the modulation waveform',
    signatures: [{
      label: 'tremoloskew(amount)',
      parameters: [
        { label: 'amount', documentation: 'between 0 & 1, the shape of the waveform' }
      ],
    }],
  },
  {
    name: 'tremolophase',
    detail: 'Alter the phase of the modulation waveform',
    documentation: 'Alter the phase of the modulation waveform',
    signatures: [{
      label: 'tremolophase(offset)',
      parameters: [
        { label: 'offset', documentation: 'the offset in cycles of the modulation' }
      ],
    }],
  },
  {
    name: 'tremoloshape',
    detail: 'Shape of amplitude modulation',
    documentation: 'Shape of amplitude modulation',
    signatures: [{
      label: 'tremoloshape(shape)',
      parameters: [
        { label: 'shape', documentation: 'tri | square | sine | saw | ramp' }
      ],
    }],
  },
  {
    name: 'drive',
    detail: 'Filter overdrive for supported filter types)',
    documentation: 'Filter overdrive for supported filter types).',
    signatures: [{
      label: 'drive(amount)',
      parameters: [
        { label: 'amount', documentation: '* @example' }
      ],
    }],
  },
  {
    name: 'duckorbit',
    detail: 'Modulate the amplitude of an orbit to create a "sidechain" l',
    documentation: 'Modulate the amplitude of an orbit to create a "sidechain" like effect. Can be applied to multiple orbits with the \':\' mininotation, e.g. `` $:). $: $:). $: $:',
    signatures: [{
      label: 'duckorbit(orbit)',
      parameters: [
        { label: 'orbit', documentation: 'target orbit' }
      ],
    }],
  },
  {
    name: 'duckdepth',
    detail: 'The amount of ducking applied to target orbit Can vary acros',
    documentation: 'The amount of ducking applied to target orbit Can vary across orbits with the \':\' mininotation, e.g. ``. Note: this requires first applying the effect to multiple orbits with e.g. ``.).,) $:). $: $:',
    signatures: [{
      label: 'duckdepth(depth)',
      parameters: [
        { label: 'depth', documentation: 'depth of modulation from 0 to 1' }
      ],
    }],
  },
  {
    name: 'duckonset',
    detail: 'The time required for the ducked to reach their lowest volum',
    documentation: 'The time required for the ducked to reach their lowest volume. Can be used to prevent clicking or for creative rhythmic effects. Can vary across orbits with the \':\' mininotation, e.g. ``. Note: this requires first applying the effect to multiple orbits with e.g. ``. // Clicks sound: duckerWithClick: // No clicks sound: duckerWithoutClick: // Rhythmic noise: // used rhythmically with 0.3 onset below hhat: ducker:',
    signatures: [{
      label: 'duckonset(time)',
      parameters: [
        { label: 'time', documentation: 'The onset time in seconds' }
      ],
    }],
  },
  {
    name: 'duckattack',
    detail: 'The time required for the ducked to return to their normal v',
    documentation: 'The time required for the ducked to return to their normal volume. Can vary across orbits with the \':\' mininotation, e.g. ``. Note: this requires first applying the effect to multiple orbits with e.g. ``. sound:). ducker: moreduck:). lessduck: ducker:',
    signatures: [{
      label: 'duckattack(time)',
      parameters: [
        { label: 'time', documentation: 'The attack time in seconds' }
      ],
    }],
  },
  {
    name: 'byteBeatExpression',
    detail: 'Create byte beats with custom expressions\')',
    documentation: 'Create byte beats with custom expressions\')',
    signatures: [{
      label: 'byteBeatExpression(byteBeatExpression)',
      parameters: [
        { label: 'byteBeatExpression', documentation: 'bitwise expression for creating bytebeat' }
      ],
    }],
  },
  {
    name: 'byteBeatStartTime',
    detail: 'Create byte beats with custom expressions)',
    documentation: 'Create byte beats with custom expressions).)._',
    signatures: [{
      label: 'byteBeatStartTime(byteBeatStartTime)',
      parameters: [
        { label: 'byteBeatStartTime', documentation: 'in samples (t)' }
      ],
    }],
  },
  {
    name: 'channels',
    detail: 'Allows you to set the output channels on the interface',
    documentation: 'Allows you to set the output channels on the interface',
    signatures: [{
      label: 'channels(channels)',
      parameters: [
        { label: 'channels', documentation: 'pattern the output channels' }
      ],
    }],
  },
  {
    name: 'pw',
    detail: 'Controls the pulsewidth of the pulse oscillator)',
    documentation: 'Controls the pulsewidth of the pulse oscillator).',
    signatures: [{
      label: 'pw(pulsewidth)',
      parameters: [
        { label: 'pulsewidth', documentation: '* @example' }
      ],
    }],
  },
  {
    name: 'pwrate',
    detail: 'Controls the lfo rate for the pulsewidth of the pulse oscill',
    documentation: 'Controls the lfo rate for the pulsewidth of the pulse oscillator).',
    signatures: [{
      label: 'pwrate(rate)',
      parameters: [
        { label: 'rate', documentation: '* @example' }
      ],
    }],
  },
  {
    name: 'pwsweep',
    detail: 'Controls the lfo sweep for the pulsewidth of the pulse oscil',
    documentation: 'Controls the lfo sweep for the pulsewidth of the pulse oscillator).',
    signatures: [{
      label: 'pwsweep(sweep)',
      parameters: [
        { label: 'sweep', documentation: '* @example' }
      ],
    }],
  },
  {
    name: 'phasersweep',
    detail: 'The frequency sweep range of the lfo for the phaser effect',
    documentation: 'The frequency sweep range of the lfo for the phaser effect. Defaults to 2000). .',
    signatures: [{
      label: 'phasersweep(phasersweep)',
      parameters: [
        { label: 'phasersweep', documentation: 'most useful values are between 0 and 4000' }
      ],
    }],
  },
  {
    name: 'phasercenter',
    detail: 'The center frequency of the phaser in HZ',
    documentation: 'The center frequency of the phaser in HZ. Defaults to 1000). .',
    signatures: [{
      label: 'phasercenter(centerfrequency)',
      parameters: [
        { label: 'centerfrequency', documentation: 'in HZ' }
      ],
    }],
  },
  {
    name: 'phaserdepth',
    detail: 'The amount the signal is affected by the phaser effect',
    documentation: 'The amount the signal is affected by the phaser effect. Defaults to 0.75). . / // also a superdirt control export const { phaserdepth, phd, phasdp } =; /** Choose the channel the pattern is sent to in superdirt',
    signatures: [{
      label: 'phaserdepth(depth, channel)',
      parameters: [
        { label: 'depth', documentation: 'number between 0 and 1' },
        { label: 'channel', documentation: 'channel number' }
      ],
    }],
  },
  {
    name: 'lpenv',
    detail: 'Sets the lowpass filter envelope modulation depth',
    documentation: 'Sets the lowpass filter envelope modulation depth. . . . .',
    signatures: [{
      label: 'lpenv(modulation)',
      parameters: [
        { label: 'modulation', documentation: 'depth of the lowpass filter envelope between 0 and _n_' }
      ],
    }],
  },
  {
    name: 'hpenv',
    detail: 'Sets the highpass filter envelope modulation depth',
    documentation: 'Sets the highpass filter envelope modulation depth. . . . .',
    signatures: [{
      label: 'hpenv(modulation)',
      parameters: [
        { label: 'modulation', documentation: 'depth of the highpass filter envelope between 0 and _n_' }
      ],
    }],
  },
  {
    name: 'bpenv',
    detail: 'Sets the bandpass filter envelope modulation depth',
    documentation: 'Sets the bandpass filter envelope modulation depth. . . . .',
    signatures: [{
      label: 'bpenv(modulation)',
      parameters: [
        { label: 'modulation', documentation: 'depth of the bandpass filter envelope between 0 and _n_' }
      ],
    }],
  },
  {
    name: 'lpattack',
    detail: 'Sets the attack duration for the lowpass filter envelope',
    documentation: 'Sets the attack duration for the lowpass filter envelope. . . . .',
    signatures: [{
      label: 'lpattack(attack)',
      parameters: [
        { label: 'attack', documentation: 'time of the filter envelope' }
      ],
    }],
  },
  {
    name: 'hpattack',
    detail: 'Sets the attack duration for the highpass filter envelope',
    documentation: 'Sets the attack duration for the highpass filter envelope. . . . .',
    signatures: [{
      label: 'hpattack(attack)',
      parameters: [
        { label: 'attack', documentation: 'time of the highpass filter envelope' }
      ],
    }],
  },
  {
    name: 'bpattack',
    detail: 'Sets the attack duration for the bandpass filter envelope',
    documentation: 'Sets the attack duration for the bandpass filter envelope. . . . .',
    signatures: [{
      label: 'bpattack(attack)',
      parameters: [
        { label: 'attack', documentation: 'time of the bandpass filter envelope' }
      ],
    }],
  },
  {
    name: 'lpdecay',
    detail: 'Sets the decay duration for the lowpass filter envelope',
    documentation: 'Sets the decay duration for the lowpass filter envelope. . . . .',
    signatures: [{
      label: 'lpdecay(decay)',
      parameters: [
        { label: 'decay', documentation: 'time of the filter envelope' }
      ],
    }],
  },
  {
    name: 'hpdecay',
    detail: 'Sets the decay duration for the highpass filter envelope',
    documentation: 'Sets the decay duration for the highpass filter envelope. . . . . .',
    signatures: [{
      label: 'hpdecay(decay)',
      parameters: [
        { label: 'decay', documentation: 'time of the highpass filter envelope' }
      ],
    }],
  },
  {
    name: 'bpdecay',
    detail: 'Sets the decay duration for the bandpass filter envelope',
    documentation: 'Sets the decay duration for the bandpass filter envelope. . . . . .',
    signatures: [{
      label: 'bpdecay(decay)',
      parameters: [
        { label: 'decay', documentation: 'time of the bandpass filter envelope' }
      ],
    }],
  },
  {
    name: 'lpsustain',
    detail: 'Sets the sustain amplitude for the lowpass filter envelope',
    documentation: 'Sets the sustain amplitude for the lowpass filter envelope. . . . . .',
    signatures: [{
      label: 'lpsustain(sustain)',
      parameters: [
        { label: 'sustain', documentation: 'amplitude of the lowpass filter envelope' }
      ],
    }],
  },
  {
    name: 'hpsustain',
    detail: 'Sets the sustain amplitude for the highpass filter envelope',
    documentation: 'Sets the sustain amplitude for the highpass filter envelope. . . . . .',
    signatures: [{
      label: 'hpsustain(sustain)',
      parameters: [
        { label: 'sustain', documentation: 'amplitude of the highpass filter envelope' }
      ],
    }],
  },
  {
    name: 'bpsustain',
    detail: 'Sets the sustain amplitude for the bandpass filter envelope',
    documentation: 'Sets the sustain amplitude for the bandpass filter envelope. . . . . .',
    signatures: [{
      label: 'bpsustain(sustain)',
      parameters: [
        { label: 'sustain', documentation: 'amplitude of the bandpass filter envelope' }
      ],
    }],
  },
  {
    name: 'lprelease',
    detail: 'Sets the release time for the lowpass filter envelope',
    documentation: 'Sets the release time for the lowpass filter envelope. . . . . . .',
    signatures: [{
      label: 'lprelease(release)',
      parameters: [
        { label: 'release', documentation: 'time of the filter envelope' }
      ],
    }],
  },
  {
    name: 'hprelease',
    detail: 'Sets the release time for the highpass filter envelope',
    documentation: 'Sets the release time for the highpass filter envelope. . . . . . .',
    signatures: [{
      label: 'hprelease(release)',
      parameters: [
        { label: 'release', documentation: 'time of the highpass filter envelope' }
      ],
    }],
  },
  {
    name: 'bprelease',
    detail: 'Sets the release time for the bandpass filter envelope',
    documentation: 'Sets the release time for the bandpass filter envelope. . . . . . .',
    signatures: [{
      label: 'bprelease(release)',
      parameters: [
        { label: 'release', documentation: 'time of the bandpass filter envelope' }
      ],
    }],
  },
  {
    name: 'ftype',
    detail: 'Sets the filter type',
    documentation: 'Sets the filter type. The ladder filter is more aggressive. More types might be added in the future. . . . .',
    signatures: [{
      label: 'ftype(type)',
      parameters: [
        { label: 'type', documentation: '12db (0), ladder (1), or 24db (2)' }
      ],
    }],
  },
  {
    name: 'fanchor',
    detail: 'controls the center of the filter envelope',
    documentation: 'controls the center of the filter envelope. 0 is unipolar positive, .5 is bipolar, 1 is unipolar negative .',
    signatures: [{
      label: 'fanchor(center)',
      parameters: [
        { label: 'center', documentation: '0 to 1' }
      ],
    }],
  },
  {
    name: 'vibmod',
    detail: 'Sets the vibrato depth in semitones',
    documentation: 'Sets the vibrato depth in semitones. Only has an effect if `vibrato` | `vib` | `v` is is also set . ._ // change the vibrato frequency with ":" . ._',
    signatures: [{
      label: 'vibmod(depth)',
      parameters: [
        { label: 'depth', documentation: 'of vibrato (in semitones)' }
      ],
    }],
  },
  {
    name: 'hpq',
    detail: 'Controls the **h**igh-**p**ass **q**-value',
    documentation: 'Controls the **h**igh-**p**ass **q**-value.',
    signatures: [{
      label: 'hpq(q)',
      parameters: [
        { label: 'q', documentation: 'resonance factor between 0 and 50' }
      ],
    }],
  },
  {
    name: 'lpq',
    detail: 'Controls the **l**ow-**p**ass **q**-value',
    documentation: 'Controls the **l**ow-**p**ass **q**-value. / // currently an alias of \'resonance\' https://codeberg.org/uzu/strudel/issues/496 export const { resonance, lpq } =; /** DJ filter, below 0.5 is low pass filter, above is high pass filter.).',
    signatures: [{
      label: 'lpq(q, cutoff)',
      parameters: [
        { label: 'q', documentation: 'resonance factor between 0 and 50' },
        { label: 'cutoff', documentation: 'below 0.5 is low pass filter, above is high pass filter' }
      ],
    }],
  },
  {
    name: 'delayspeed',
    detail: 'Sets the time of the delay effect',
    documentation: 'Sets the time of the delay effect.).',
    signatures: [{
      label: 'delayspeed(delayspeed)',
      parameters: [
        { label: 'delayspeed', documentation: 'controls the pitch of the delay feedback' }
      ],
    }],
  },
  {
    name: 'delaysync',
    detail: 'Sets the time of the delay effect in cycles',
    documentation: 'Sets the time of the delay effect in cycles.)',
    signatures: [{
      label: 'delaysync(cycles)',
      parameters: [
        { label: 'cycles', documentation: 'delay length in cycles' }
      ],
    }],
  },
  {
    name: 'lock',
    detail: 'Specifies whether delaytime is calculated relative to cps',
    documentation: 'Specifies whether delaytime is calculated relative to cps.',
    signatures: [{
      label: 'lock(enable)',
      parameters: [
        { label: 'enable', documentation: 'When set to 1, delaytime is a direct multiple of a cycle.' }
      ],
    }],
  },
  {
    name: 'spread',
    detail: 'Set the stereo pan spread for supported oscillators',
    documentation: 'Set the stereo pan spread for supported oscillators',
    signatures: [{
      label: 'spread(spread)',
      parameters: [
        { label: 'spread', documentation: 'between 0 and 1' }
      ],
    }],
  },
  {
    name: 'dry',
    detail: 'Set dryness of reverb',
    documentation: 'Set dryness of reverb. See `room` and `size` for more information about reverb.").',
    signatures: [{
      label: 'dry(dry)',
      parameters: [
        { label: 'dry', documentation: '0 = wet, 1 = dry' }
      ],
    }],
  },
  {
    name: 'pattack',
    detail: 'Attack time of pitch envelope',
    documentation: 'Attack time of pitch envelope.',
    signatures: [{
      label: 'pattack(time)',
      parameters: [
        { label: 'time', documentation: 'time in seconds' }
      ],
    }],
  },
  {
    name: 'pdecay',
    detail: 'Decay time of pitch envelope',
    documentation: 'Decay time of pitch envelope.',
    signatures: [{
      label: 'pdecay(time)',
      parameters: [
        { label: 'time', documentation: 'time in seconds' }
      ],
    }],
  },
  {
    name: 'prelease',
    detail: 'Release time of pitch envelope ',
    documentation: 'Release time of pitch envelope . // to hear the pitch release .',
    signatures: [{
      label: 'prelease(time)',
      parameters: [
        { label: 'time', documentation: 'time in seconds' }
      ],
    }],
  },
  {
    name: 'penv',
    detail: 'Amount of pitch envelope',
    documentation: 'Amount of pitch envelope. Negative values will flip the envelope. If you don\'t set other pitch envelope controls, `pattack:.2` will be the default. .',
    signatures: [{
      label: 'penv(semitones)',
      parameters: [
        { label: 'semitones', documentation: 'change in semitones' }
      ],
    }],
  },
  {
    name: 'pcurve',
    detail: 'Curve of envelope',
    documentation: 'Curve of envelope. Defaults to linear. exponential is good for kicks . . .',
    signatures: [{
      label: 'pcurve(type)',
      parameters: [
        { label: 'type', documentation: '0 = linear, 1 = exponential' }
      ],
    }],
  },
  {
    name: 'panchor',
    detail: 'Sets the range anchor of the envelope: - anchor 0: range = [',
    documentation: 'Sets the range anchor of the envelope: - anchor 0: range = [note, note + penv] - anchor 1: range = [note - penv, note] If you don\'t set an anchor, the value will default to the psustain value.',
    signatures: [{
      label: 'panchor(anchor)',
      parameters: [
        { label: 'anchor', documentation: 'anchor offset' }
      ],
    }],
  },
  {
    name: 'lrate',
    detail: 'Rate of modulation / rotation for leslie effect / // TODO: t',
    documentation: 'Rate of modulation / rotation for leslie effect / // TODO: the rate seems to "lag" (in the example, 1 will be fast) export const { lrate } =; /** Physical size of the cabinet in meters. Be careful, it might be slightly larger than your computer. Affects the Doppler amount (pitch warble)',
    signatures: [{
      label: 'lrate(rate, meters)',
      parameters: [
        { label: 'rate', documentation: '6.7 for fast, 0.7 for slow' },
        { label: 'meters', documentation: 'somewhere between 0 and 1' }
      ],
    }],
  },
  {
    name: 'label',
    detail: 'Sets the displayed text for an event on the pianoroll',
    documentation: 'Sets the displayed text for an event on the pianoroll',
    signatures: [{
      label: 'label(label)',
      parameters: [
        { label: 'label', documentation: 'text to display' }
      ],
    }],
  },
  {
    name: 'roomlp',
    detail: 'Reverb lowpass starting frequency (in hertz)',
    documentation: 'Reverb lowpass starting frequency (in hertz). When this property is changed, the reverb will be recaculated, so only change this sparsely..',
    signatures: [{
      label: 'roomlp(frequency)',
      parameters: [
        { label: 'frequency', documentation: 'between 0 and 20000hz' }
      ],
    }],
  },
  {
    name: 'roomdim',
    detail: 'Reverb lowpass frequency at -60dB (in hertz)',
    documentation: 'Reverb lowpass frequency at -60dB (in hertz). When this property is changed, the reverb will be recaculated, so only change this sparsely..',
    signatures: [{
      label: 'roomdim(frequency)',
      parameters: [
        { label: 'frequency', documentation: 'between 0 and 20000hz' }
      ],
    }],
  },
  {
    name: 'roomfade',
    detail: 'Reverb fade time (in seconds)',
    documentation: 'Reverb fade time (in seconds). When this property is changed, the reverb will be recaculated, so only change this sparsely..',
    signatures: [{
      label: 'roomfade(seconds)',
      parameters: [
        { label: 'seconds', documentation: 'for the reverb to fade' }
      ],
    }],
  },
  {
    name: 'iresponse',
    detail: 'Sets the sample to use as an impulse response for the reverb',
    documentation: 'Sets the sample to use as an impulse response for the reverb.',
    signatures: [{
      label: 'iresponse(sample)',
      parameters: [
        { label: 'sample', documentation: 'to use as an impulse response' }
      ],
    }],
  },
  {
    name: 'irspeed',
    detail: 'Sets speed of the sample for the impulse response',
    documentation: 'Sets speed of the sample for the impulse response. $:).',
    signatures: [{
      label: 'irspeed(speed)',
      parameters: [
        { label: 'speed', documentation: '* @example' }
      ],
    }],
  },
  {
    name: 'irbegin',
    detail: 'Sets the beginning of the IR response sample $:)',
    documentation: 'Sets the beginning of the IR response sample $:).',
    signatures: [{
      label: 'irbegin(begin)',
      parameters: [
        { label: 'begin', documentation: 'between 0 and 1' }
      ],
    }],
  },
  {
    name: 'roomsize',
    detail: 'Sets the room size of the reverb, see `room`',
    documentation: 'Sets the room size of the reverb, see `room`. When this property is changed, the reverb will be recaculated, so only change this sparsely.. / // TODO: find out why : // // .. does not work. Is it because room is only one effect? export const { roomsize, size, sz, rsize } =; // [\'sagogo\'], // [\'sclap\'], // [\'sclaves\'], // [\'scrash\'], /** (Deprecated) Wave shaping distortion. WARNING: can suddenly get unpredictably loud. Please use distort instead, which has a more predictable response curve second option in optional array syntax (ex: ".9:.5") applies a postgain to the output',
    signatures: [{
      label: 'roomsize(size, distortion)',
      parameters: [
        { label: 'size', documentation: 'between 0 and 10' },
        { label: 'distortion', documentation: 'between 0 and 1' }
      ],
    }],
  },
  {
    name: 'distortvol',
    detail: 'Postgain for waveshaping distortion',
    documentation: 'Postgain for waveshaping distortion.',
    signatures: [{
      label: 'distortvol(volume)',
      parameters: [
        { label: 'volume', documentation: 'linear postgain of the distortion' }
      ],
    }],
  },
  {
    name: 'distorttype',
    detail: 'Type of waveshaping distortion to apply',
    documentation: 'Type of waveshaping distortion to apply. . .) .',
    signatures: [{
      label: 'distorttype(type)',
      parameters: [
        { label: 'type', documentation: 'type of distortion to apply' }
      ],
    }],
  },
  {
    name: 'compressor',
    detail: 'Dynamics Compressor',
    documentation: 'Dynamics Compressor. The params are `` More info [here](https://developer.mozilla.org/en-US/docs/Web/API/DynamicsCompressorNode?retiredLocale=de#instance_properties) .',
    signatures: [{
      label: 'compressor()',
      parameters: [

      ],
    }],
  },
  {
    name: 'stretch',
    detail: 'Changes the speed of sample playback, i',
    documentation: 'Changes the speed of sample playback, i.e. a cheap way of changing pitch.',
    signatures: [{
      label: 'stretch(factor)',
      parameters: [
        { label: 'factor', documentation: '-inf to inf, negative numbers play the sample backwards.' }
      ],
    }],
  },
  {
    name: 'density',
    detail: 'Noise crackle density)',
    documentation: 'Noise crackle density)',
    signatures: [{
      label: 'density(density)',
      parameters: [
        { label: 'density', documentation: 'between 0 and x' }
      ],
    }],
  },
  {
    name: 'duration',
    detail: 'Sets the duration of the event in cycles',
    documentation: 'Sets the duration of the event in cycles. Similar to clip / legato, it also cuts samples off at the end if they exceed the duration.',
    signatures: [{
      label: 'duration(seconds)',
      parameters: [
        { label: 'seconds', documentation: '>= 0' }
      ],
    }],
  },
  {
    name: 'midicmd',
    detail: 'MIDI command: Sends a MIDI command message',
    documentation: 'MIDI command: Sends a MIDI command message.',
    signatures: [{
      label: 'midicmd(command)',
      parameters: [
        { label: 'command', documentation: 'MIDI command' }
      ],
    }],
  },
  {
    name: 'control',
    detail: 'MIDI control: Sends a MIDI control change message',
    documentation: 'MIDI control: Sends a MIDI control change message.',
    signatures: [{
      label: 'control(MIDI, MIDI)',
      parameters: [
        { label: 'MIDI', documentation: 'control number (0-127)' },
        { label: 'MIDI', documentation: 'controller value (0-127)' }
      ],
    }],
  },
  {
    name: 'nrpnn',
    detail: 'MIDI NRPN non-registered parameter number: Sends a MIDI NRPN',
    documentation: 'MIDI NRPN non-registered parameter number: Sends a MIDI NRPN non-registered parameter number message.',
    signatures: [{
      label: 'nrpnn(nrpnn)',
      parameters: [
        { label: 'nrpnn', documentation: 'MIDI NRPN non-registered parameter number (0-127)' }
      ],
    }],
  },
  {
    name: 'nrpv',
    detail: 'MIDI NRPN non-registered parameter value: Sends a MIDI NRPN ',
    documentation: 'MIDI NRPN non-registered parameter value: Sends a MIDI NRPN non-registered parameter value message.',
    signatures: [{
      label: 'nrpv(nrpv)',
      parameters: [
        { label: 'nrpv', documentation: 'MIDI NRPN non-registered parameter value (0-127)' }
      ],
    }],
  },
  {
    name: 'progNum',
    detail: 'MIDI program number: Sends a MIDI program change message',
    documentation: 'MIDI program number: Sends a MIDI program change message.',
    signatures: [{
      label: 'progNum(program)',
      parameters: [
        { label: 'program', documentation: 'MIDI program number (0-127)' }
      ],
    }],
  },
  {
    name: 'sysex',
    detail: 'MIDI sysex: Sends a MIDI sysex message',
    documentation: 'MIDI sysex: Sends a MIDI sysex message.',
    signatures: [{
      label: 'sysex(id, data)',
      parameters: [
        { label: 'id', documentation: 'Sysex ID' },
        { label: 'data', documentation: 'Sysex data' }
      ],
    }],
  },
  {
    name: 'sysexid',
    detail: 'MIDI sysex ID: Sends a MIDI sysex identifier message',
    documentation: 'MIDI sysex ID: Sends a MIDI sysex identifier message.',
    signatures: [{
      label: 'sysexid(id)',
      parameters: [
        { label: 'id', documentation: 'Sysex ID' }
      ],
    }],
  },
  {
    name: 'sysexdata',
    detail: 'MIDI sysex data: Sends a MIDI sysex message',
    documentation: 'MIDI sysex data: Sends a MIDI sysex message.',
    signatures: [{
      label: 'sysexdata(data)',
      parameters: [
        { label: 'data', documentation: 'Sysex data' }
      ],
    }],
  },
  {
    name: 'midibend',
    detail: 'MIDI pitch bend: Sends a MIDI pitch bend message',
    documentation: 'MIDI pitch bend: Sends a MIDI pitch bend message.).',
    signatures: [{
      label: 'midibend(midibend)',
      parameters: [
        { label: 'midibend', documentation: 'MIDI pitch bend (-1 - 1)' }
      ],
    }],
  },
  {
    name: 'miditouch',
    detail: 'MIDI key after touch: Sends a MIDI key after touch message',
    documentation: 'MIDI key after touch: Sends a MIDI key after touch message.).',
    signatures: [{
      label: 'miditouch(miditouch)',
      parameters: [
        { label: 'miditouch', documentation: 'MIDI key after touch (0-1)' }
      ],
    }],
  },
  {
    name: 'oschost',
    detail: 'The host to send open sound control messages to',
    documentation: 'The host to send open sound control messages to. Requires running the OSC bridge.;',
    signatures: [{
      label: 'oschost(oschost)',
      parameters: [
        { label: 'oschost', documentation: 'e.g. \'localhost\'' }
      ],
    }],
  },
  {
    name: 'oscport',
    detail: 'The port to send open sound control messages to',
    documentation: 'The port to send open sound control messages to. Requires running the OSC bridge.;',
    signatures: [{
      label: 'oscport(oscport)',
      parameters: [
        { label: 'oscport', documentation: 'e.g. 57120' }
      ],
    }],
  },
  {
    name: 'as',
    detail: 'Sets properties in a batch',
    documentation: 'Sets properties in a batch. "c:.5 a:1 f:.25 e:.8". "{0@2 0.25 0 0.5 .3 .5}%8".',
    signatures: [{
      label: 'as(mapping)',
      parameters: [
        { label: 'mapping', documentation: 'the control names that are set' }
      ],
    }],
  },
  {
    name: 'scrub',
    detail: 'Allows you to scrub an audio file like a tape loop by passin',
    documentation: 'Allows you to scrub an audio file like a tape loop by passing values that represents the position in the audio file in the optional array syntax ex: "0.5:2", the second value controls the speed of playback;)',
    signatures: [{
      label: 'scrub()',
      parameters: [

      ],
    }],
  },
  {
    name: 'euclidish',
    detail: 'A \'euclid\' variant with an additional parameter that morphs ',
    documentation: 'A \'euclid\' variant with an additional parameter that morphs the resulting rhythm from 0 (no morphing) to 1 (completely \'even\'). For example `` would be the same as ``, and `` would be the same as ``. `` would have a groove somewhere between. Inspired by the work of Malcom Braff.) .)',
    signatures: [{
      label: 'euclidish(pulses, steps, groove)',
      parameters: [
        { label: 'pulses', documentation: 'the number of onsets' },
        { label: 'steps', documentation: 'the number of steps to fill' },
        { label: 'groove', documentation: 'exists between the extremes of 0 (straight euclidian) and 1 (straight pulse)' }
      ],
    }],
  },
  {
    name: 'round',
    detail: 'Assumes a numerical pattern',
    documentation: 'Assumes a numerical pattern. Returns a new pattern with all values rounded to the nearest integer.).',
    signatures: [{
      label: 'round()',
      parameters: [

      ],
    }],
  },
  {
    name: 'floor',
    detail: 'Assumes a numerical pattern',
    documentation: 'Assumes a numerical pattern. Returns a new pattern with all values set to their mathematical floor. E.g. `3.7` replaced with to `3`, and `-4.2` replaced with `-5`.)',
    signatures: [{
      label: 'floor()',
      parameters: [

      ],
    }],
  },
  {
    name: 'ceil',
    detail: 'Assumes a numerical pattern',
    documentation: 'Assumes a numerical pattern. Returns a new pattern with all values set to their mathematical ceiling. E.g. `3.2` replaced with `4`, and `-4.2` replaced with `-4`.)',
    signatures: [{
      label: 'ceil()',
      parameters: [

      ],
    }],
  },
  {
    name: 'rangex',
    detail: 'Assumes a numerical pattern, containing unipolar values in t',
    documentation: 'Assumes a numerical pattern, containing unipolar values in the range 0 .. 1 Returns a new pattern with values scaled to the given min/max range, following an exponential curve. .)',
    signatures: [{
      label: 'rangex()',
      parameters: [

      ],
    }],
  },
  {
    name: 'range2',
    detail: 'Assumes a numerical pattern, containing bipolar values in th',
    documentation: 'Assumes a numerical pattern, containing bipolar values in the range -1 .. 1 Returns a new pattern with values scaled to the given min/max range. .)',
    signatures: [{
      label: 'range2()',
      parameters: [

      ],
    }],
  },
  {
    name: 'ratio',
    detail: 'Allows dividing numbers via list notation using ":"',
    documentation: 'Allows dividing numbers via list notation using ":". Returns a new pattern with just numbers. .',
    signatures: [{
      label: 'ratio()',
      parameters: [

      ],
    }],
  },
  {
    name: 'invert',
    detail: 'Swaps 1s and 0s in a binary pattern',
    documentation: 'Swaps 1s and 0s in a binary pattern.)',
    signatures: [{
      label: 'invert()',
      parameters: [

      ],
    }],
  },
  {
    name: 'echoWith',
    detail: 'Superimpose and offset multiple times, applying the given fu',
    documentation: 'Superimpose and offset multiple times, applying the given function each time. "<0 [2 4]>" . => p.) .',
    signatures: [{
      label: 'echoWith(times, time, func)',
      parameters: [
        { label: 'times', documentation: 'how many times to repeat' },
        { label: 'time', documentation: 'cycle offset between iterations' },
        { label: 'func', documentation: 'function to apply, given the pattern and the iteration index' }
      ],
    }],
  },
  {
    name: 'plyWith',
    detail: 'The plyWith function repeats each event the given number of ',
    documentation: 'The plyWith function repeats each event the given number of times, applying the given function to each event.\n "<0 [2 4]>" . => p.) .',
    signatures: [{
      label: 'plyWith(factor, func)',
      parameters: [
        { label: 'factor', documentation: 'how many times to repeat' },
        { label: 'func', documentation: 'function to apply, given the pattern' }
      ],
    }],
  },
  {
    name: 'plyForEach',
    detail: 'The plyForEach function repeats each event the given number ',
    documentation: 'The plyForEach function repeats each event the given number of times, applying the given function to each event. This version of ply uses the iteration index as an argument to the function, similar to echoWith. "<0 [2 4]>" . => p.) .',
    signatures: [{
      label: 'plyForEach(factor, func)',
      parameters: [
        { label: 'factor', documentation: 'how many times to repeat' },
        { label: 'func', documentation: 'function to apply, given the pattern and the iteration index' }
      ],
    }],
  },
  {
    name: 'repeatCycles',
    detail: 'Repeats each cycle the given number of times',
    documentation: 'Repeats each cycle the given number of times.).',
    signatures: [{
      label: 'repeatCycles()',
      parameters: [

      ],
    }],
  },
  {
    name: 'fastChunk',
    detail: 'Like `chunk`, but the cycles of the source pattern aren\'t re',
    documentation: 'Like `chunk`, but the cycles of the source pattern aren\'t repeated for each set of chunks. "<0 8> 1 2 3 4 5 6 7" .). .',
    signatures: [{
      label: 'fastChunk()',
      parameters: [

      ],
    }],
  },
  {
    name: 'chunkInto',
    detail: 'Like `chunk`, but the function is applied to a looped subcyc',
    documentation: 'Like `chunk`, but the function is applied to a looped subcycle of the source pattern.) .',
    signatures: [{
      label: 'chunkInto()',
      parameters: [

      ],
    }],
  },
  {
    name: 'chunkBackInto',
    detail: 'Like `chunkInto`, but moves backwards through the chunks',
    documentation: 'Like `chunkInto`, but moves backwards through the chunks.) .',
    signatures: [{
      label: 'chunkBackInto()',
      parameters: [

      ],
    }],
  },
  {
    name: 'ribbon',
    detail: 'Loops the pattern inside an `offset` for `cycles`',
    documentation: 'Loops the pattern inside an `offset` for `cycles`. If you think of the entire span of time in cycles as a ribbon, you can cut a single piece and loop it. // Looping a portion of randomness). // rhythm generator',
    signatures: [{
      label: 'ribbon(offset, cycles)',
      parameters: [
        { label: 'offset', documentation: 'start point of loop in cycles' },
        { label: 'cycles', documentation: 'loop length in cycles' }
      ],
    }],
  },
  {
    name: 'tag',
    detail: 'Tags each Hap with an identifier',
    documentation: 'Tags each Hap with an identifier. Good for filtering. The function populates Hap.context.tags (Array). / Pattern.prototype.tag = function (tag) { return this. => ({ ...ctx, tags: (ctx.tags || []). })); }; /** Filters haps using the given function',
    signatures: [{
      label: 'tag(tag, test)',
      parameters: [
        { label: 'tag', documentation: 'anything unique' },
        { label: 'test', documentation: 'function to test Hap' }
      ],
    }],
  },
  {
    name: 'filterWhen',
    detail: 'Filters haps by their begin time',
    documentation: 'Filters haps by their begin time',
    signatures: [{
      label: 'filterWhen(test)',
      parameters: [
        { label: 'test', documentation: 'function to test Hap.whole.begin' }
      ],
    }],
  },
  {
    name: 'stepcat',
    detail: '\'Concatenates\' patterns like `fastcat`, but proportional to ',
    documentation: '\'Concatenates\' patterns like `fastcat`, but proportional to a number of steps per cycle. The steps can either be inferred from the pattern, or provided as a [length, pattern] pair. Has the alias `timecat`. // the same as "e3@3 g3". // the same as "bd sd cp hh hh".',
    signatures: [{
      label: 'stepcat()',
      parameters: [

      ],
    }],
  },
  {
    name: 'onTriggerTime',
    detail: 'make something happen on event time uses browser timeout whi',
    documentation: 'make something happen on event time uses browser timeout which is innacurate for audio tasks => {console.}) / Pattern.prototype.onTriggerTime = function (func) { return this. => { const diff = targetTime - currentTime; window. => {; }, diff * 1000); }, false); }; /** Works the same as slice, but changes the playback speed of each slice to match the duration of its step. .',
    signatures: [{
      label: 'onTriggerTime()',
      parameters: [

      ],
    }],
  },
  {
    name: 'loopAtCps',
    detail: 'Makes the sample fit the given number of cycles and cps valu',
    documentation: 'Makes the sample fit the given number of cycles and cps value, by changing the speed. Please note that at some point cps will be given by a global clock and this function will be deprecated/removed. / // TODO - global cps clock export const { loopAtCps, loopatcps } = { return _; }); /** exposes a custom value at query time. basically allows mutating state without evaluation',
    signatures: [{
      label: 'loopAtCps()',
      parameters: [

      ],
    }],
  },
  {
    name: 'xfade',
    detail: 'Cross-fades between left and right from 0 to 1: - 0 = (full ',
    documentation: 'Cross-fades between left and right from 0 to 1: - 0 = (full left, no right) - .5 = (both equal) - 1 = (no left, full right), "<0 .25 .5 .75 1>",)',
    signatures: [{
      label: 'xfade()',
      parameters: [

      ],
    }],
  },
  {
    name: 'beat',
    detail: 'creates a structure pattern from divisions of a cycle especi',
    documentation: 'creates a structure pattern from divisions of a cycle especially useful for creating rhythms / const __beat = (join) => (t, div, pat) => { t =; div =; const b = t.; const e = t.; return =>._)); }; export const { beat } = => x.), ); export const _morph = (from, to, by) => { by =; const dur =; const positions = (list) => { const result = []; for (const [pos, value] of list.) { if (value) { result., value]); } } return result; }; const arcs = => { const b = by.; const e = b.; return new; },,, ); function { const cycle = state.span.begin.; const cycleArc = state.span.; const result = []; for (const whole of arcs) { const part = whole.; if (part !== undefined) { result. => x.), part. => x.), true, ), ); } } return result; } return new; }; /** Takes two binary rhythms represented as lists of 1s and 0s, and a number between 0 and 1 that morphs between them. The two lists should contain the same number of true values. ) // slowly morph between the rhythms ) )',
    signatures: [{
      label: 'beat()',
      parameters: [

      ],
    }],
  },
  {
    name: 'inhabitmod',
    detail: 'The same as `inhabit`, but if you pick a number greater than',
    documentation: 'The same as `inhabit`, but if you pick a number greater than the size of the list, it wraps around, rather than sticking at the maximum value. For example, if you pick the fifth pattern of a list of three, you\'ll get the second one.',
    signatures: [{
      label: 'inhabitmod(pat)',
      parameters: [
        { label: 'pat', documentation: '* @param {*} xs' }
      ],
    }],
  },
  {
    name: 'mousex',
    detail: 'The mouse\'s x position value ranges from 0 to 1',
    documentation: 'The mouse\'s x position value ranges from 0 to 1.). / /** The mouse\'s y position value ranges from 0 to 1.). / let _mouseY = 0, _mouseX = 0; if (typeof window !== \'undefined\') { //document.onmousemove = (e) => { document. => { _mouseY = e.clientY / document.body.clientHeight; _mouseX = e.clientX / document.body.clientWidth; }); } export const mousey = => _mouseY); export const mouseY = => _mouseY); export const mousex = => _mouseX); export const mouseX = => _mouseX); // random signals const xorwise = (x) => { const a = (x << 13) ^ x; const b = (a >> 17) ^ a; return (b << 5) ^ b; }; // stretch 300 cycles over the range of [0,2**29 == 536870912) then apply the xorshift algorithm const _frac = (x) => x - Math.; const timeToIntSeed = (x) => * 536870912)); const intSeedToRand = (x) => (x % 536870912) / 536870912; const timeToRand = (x) => Math.)); const timeToRandsPrime = (seed, n) => { const result = []; // eslint-disable-next-line for (let i = 0; i < n; ++i) { result.); seed =; } return result; }; const timeToRands = (t, n) =>, n); /** / /** A discrete pattern of numbers from 0 to n-1). //',
    signatures: [{
      label: 'mousex()',
      parameters: [

      ],
    }],
  },
  {
    name: 'brandBy',
    detail: 'A continuous pattern of 0 or 1 (binary random), with a proba',
    documentation: 'A continuous pattern of 0 or 1 (binary random), with a probability for the value being 1)',
    signatures: [{
      label: 'brandBy(probability)',
      parameters: [
        { label: 'probability', documentation: '- a number between 0 and 1' }
      ],
    }],
  },
  {
    name: 'berlin',
    detail: 'Generates a continuous pattern of [berlin noise](conceived b',
    documentation: 'Generates a continuous pattern of [berlin noise](conceived by Jame Coyne and Jade Rowland as a joke but turned out to be surprisingly cool and useful, like perlin noise but with sawtooth waves), in the range 0..1. // ascending arpeggios)).',
    signatures: [{
      label: 'berlin()',
      parameters: [

      ],
    }],
  },
  {
    name: 'undegrade',
    detail: 'Inverse of `degrade`: Randomly removes 50% of events from th',
    documentation: 'Inverse of `degrade`: Randomly removes 50% of events from the pattern. Shorthand for `.` Events that would be removed by degrade are let through by undegrade and vice versa (see second example)., x => x. )',
    signatures: [{
      label: 'undegrade()',
      parameters: [

      ],
    }],
  },
  {
    name: 'whenKey',
    detail: 'Do something on a keypress, or array of keypresses [Key name',
    documentation: 'Do something on a keypress, or array of keypresses [Key name reference](https://developer.mozilla.org/en-US/docs/Web/API/UI_Events/Keyboard_event_key_values)").).)',
    signatures: [{
      label: 'whenKey()',
      parameters: [

      ],
    }],
  },
  {
    name: 'keyDown',
    detail: 'returns true when a key or array of keys is held [Key name r',
    documentation: 'returns true when a key or array of keys is held [Key name reference](https://developer.mozilla.org/en-US/docs/Web/API/UI_Events/Keyboard_event_key_values)"),")])',
    signatures: [{
      label: 'keyDown()',
      parameters: [

      ],
    }],
  },
  {
    name: 'addVoicings',
    detail: 'Adds a new custom voicing dictionary',
    documentation: 'Adds a new custom voicing dictionary. "<C^7 A7 Dm7 G7>".',
    signatures: [{
      label: 'addVoicings(name, dictionary, range)',
      parameters: [
        { label: 'name', documentation: 'identifier for the voicing dictionary' },
        { label: 'dictionary', documentation: 'maps chord symbol to possible voicings' },
        { label: 'range', documentation: 'min, max note' }
      ],
    }],
  },

  // === ALIASES (lowercase versions) ===
  {
    name: 'chunkbackinto',
    detail: 'Alias for chunkBackInto',
    documentation: 'Lowercase alias for chunkBackInto. See chunkBackInto for full documentation.',
    signatures: [{
      label: 'chunkbackinto(...)',
      parameters: [],
    }],
  },
  {
    name: 'chunkinto',
    detail: 'Alias for chunkInto',
    documentation: 'Lowercase alias for chunkInto. See chunkInto for full documentation.',
    signatures: [{
      label: 'chunkinto(...)',
      parameters: [],
    }],
  },
  {
    name: 'echowith',
    detail: 'Alias for echoWith',
    documentation: 'Lowercase alias for echoWith. See echoWith for full documentation.',
    signatures: [{
      label: 'echowith(...)',
      parameters: [],
    }],
  },
  {
    name: 'fastchunk',
    detail: 'Alias for fastChunk',
    documentation: 'Lowercase alias for fastChunk. See fastChunk for full documentation.',
    signatures: [{
      label: 'fastchunk(...)',
      parameters: [],
    }],
  },
  {
    name: 'fastgap',
    detail: 'Alias for fastGap',
    documentation: 'Lowercase alias for fastGap. See fastGap for full documentation.',
    signatures: [{
      label: 'fastgap(...)',
      parameters: [],
    }],
  },
  {
    name: 'iterback',
    detail: 'Alias for iterBack',
    documentation: 'Lowercase alias for iterBack. See iterBack for full documentation.',
    signatures: [{
      label: 'iterback(...)',
      parameters: [],
    }],
  },
  {
    name: 'juxby',
    detail: 'Alias for juxBy',
    documentation: 'Lowercase alias for juxBy. See juxBy for full documentation.',
    signatures: [{
      label: 'juxby(...)',
      parameters: [],
    }],
  },
  {
    name: 'loopat',
    detail: 'Alias for loopAt',
    documentation: 'Lowercase alias for loopAt. See loopAt for full documentation.',
    signatures: [{
      label: 'loopat(...)',
      parameters: [],
    }],
  },
  {
    name: 'loopatcps',
    detail: 'Alias for loopAtCps',
    documentation: 'Lowercase alias for loopAtCps. See loopAtCps for full documentation.',
    signatures: [{
      label: 'loopatcps(...)',
      parameters: [],
    }],
  },

  // === SHORT PARAMETER NAMES ===
  {
    name: 'and',
    detail: 'Bitwise AND',
    documentation: 'Shorthand for bitwise AND.',
    signatures: [{
      label: 'and(value)',
      parameters: [{ label: 'value', documentation: 'Bitwise AND value' }],
    }],
  },
  {
    name: 'att',
    detail: 'Attack',
    documentation: 'Shorthand for attack.',
    signatures: [{
      label: 'att(value)',
      parameters: [{ label: 'value', documentation: 'Attack value' }],
    }],
  },
  {
    name: 'bor',
    detail: 'Bitwise OR',
    documentation: 'Shorthand for bitwise OR.',
    signatures: [{
      label: 'bor(value)',
      parameters: [{ label: 'value', documentation: 'Bitwise OR value' }],
    }],
  },
  {
    name: 'bp',
    detail: 'Bandpass filter',
    documentation: 'Shorthand for bandpass filter.',
    signatures: [{
      label: 'bp(value)',
      parameters: [{ label: 'value', documentation: 'Bandpass filter value' }],
    }],
  },
  {
    name: 'bpa',
    detail: 'Bandpass attack',
    documentation: 'Shorthand for bandpass attack.',
    signatures: [{
      label: 'bpa(value)',
      parameters: [{ label: 'value', documentation: 'Bandpass attack value' }],
    }],
  },
  {
    name: 'bpd',
    detail: 'Bandpass decay',
    documentation: 'Shorthand for bandpass decay.',
    signatures: [{
      label: 'bpd(value)',
      parameters: [{ label: 'value', documentation: 'Bandpass decay value' }],
    }],
  },
  {
    name: 'bpe',
    detail: 'Bandpass env',
    documentation: 'Shorthand for bandpass env.',
    signatures: [{
      label: 'bpe(value)',
      parameters: [{ label: 'value', documentation: 'Bandpass env value' }],
    }],
  },
  {
    name: 'bpr',
    detail: 'Bandpass release',
    documentation: 'Shorthand for bandpass release.',
    signatures: [{
      label: 'bpr(value)',
      parameters: [{ label: 'value', documentation: 'Bandpass release value' }],
    }],
  },
  {
    name: 'bps',
    detail: 'Bandpass sustain',
    documentation: 'Shorthand for bandpass sustain.',
    signatures: [{
      label: 'bps(value)',
      parameters: [{ label: 'value', documentation: 'Bandpass sustain value' }],
    }],
  },
  {
    name: 'ch',
    detail: 'Channel',
    documentation: 'Shorthand for channel.',
    signatures: [{
      label: 'ch(value)',
      parameters: [{ label: 'value', documentation: 'Channel value' }],
    }],
  },
  {
    name: 'ctf',
    detail: 'Cutoff frequency',
    documentation: 'Shorthand for cutoff frequency.',
    signatures: [{
      label: 'ctf(value)',
      parameters: [{ label: 'value', documentation: 'Cutoff frequency value' }],
    }],
  },
  {
    name: 'dec',
    detail: 'Decay',
    documentation: 'Shorthand for decay.',
    signatures: [{
      label: 'dec(value)',
      parameters: [{ label: 'value', documentation: 'Decay value' }],
    }],
  },
  {
    name: 'det',
    detail: 'Detune',
    documentation: 'Shorthand for detune.',
    signatures: [{
      label: 'det(value)',
      parameters: [{ label: 'value', documentation: 'Detune value' }],
    }],
  },
  {
    name: 'dfb',
    detail: 'Delay feedback',
    documentation: 'Shorthand for delay feedback.',
    signatures: [{
      label: 'dfb(value)',
      parameters: [{ label: 'value', documentation: 'Delay feedback value' }],
    }],
  },
  {
    name: 'djf',
    detail: 'DJ filter',
    documentation: 'Shorthand for DJ filter.',
    signatures: [{
      label: 'djf(value)',
      parameters: [{ label: 'value', documentation: 'DJ filter value' }],
    }],
  },
  {
    name: 'ds',
    detail: 'Delay send',
    documentation: 'Shorthand for delay send.',
    signatures: [{
      label: 'ds(value)',
      parameters: [{ label: 'value', documentation: 'Delay send value' }],
    }],
  },
  {
    name: 'dt',
    detail: 'Delay time',
    documentation: 'Shorthand for delay time.',
    signatures: [{
      label: 'dt(value)',
      parameters: [{ label: 'value', documentation: 'Delay time value' }],
    }],
  },
  {
    name: 'e',
    detail: 'Euclidean pattern',
    documentation: 'Shorthand for euclidean pattern.',
    signatures: [{
      label: 'e(value)',
      parameters: [{ label: 'value', documentation: 'Euclidean pattern value' }],
    }],
  },
  {
    name: 'eq',
    detail: 'Equalizer',
    documentation: 'Shorthand for equalizer.',
    signatures: [{
      label: 'eq(value)',
      parameters: [{ label: 'value', documentation: 'Equalizer value' }],
    }],
  },
  {
    name: 'eqt',
    detail: 'EQ type',
    documentation: 'Shorthand for EQ type.',
    signatures: [{
      label: 'eqt(value)',
      parameters: [{ label: 'value', documentation: 'EQ type value' }],
    }],
  },
  {
    name: 'fft',
    detail: 'FFT analysis',
    documentation: 'Shorthand for FFT analysis.',
    signatures: [{
      label: 'fft(value)',
      parameters: [{ label: 'value', documentation: 'FFT analysis value' }],
    }],
  },
  {
    name: 'gap',
    detail: 'Gap/rest',
    documentation: 'Shorthand for gap/rest.',
    signatures: [{
      label: 'gap(value)',
      parameters: [{ label: 'value', documentation: 'Gap/rest value' }],
    }],
  },
  {
    name: 'gat',
    detail: 'Gate',
    documentation: 'Shorthand for gate.',
    signatures: [{
      label: 'gat(value)',
      parameters: [{ label: 'value', documentation: 'Gate value' }],
    }],
  },
  {
    name: 'gt',
    detail: 'Greater than',
    documentation: 'Shorthand for greater than.',
    signatures: [{
      label: 'gt(value)',
      parameters: [{ label: 'value', documentation: 'Greater than value' }],
    }],
  },
  {
    name: 'gte',
    detail: 'Greater than or equal',
    documentation: 'Shorthand for greater than or equal.',
    signatures: [{
      label: 'gte(value)',
      parameters: [{ label: 'value', documentation: 'Greater than or equal value' }],
    }],
  },
  {
    name: 'h',
    detail: 'Harmonic',
    documentation: 'Shorthand for harmonic.',
    signatures: [{
      label: 'h(value)',
      parameters: [{ label: 'value', documentation: 'Harmonic value' }],
    }],
  },
  {
    name: 'hp',
    detail: 'Highpass filter',
    documentation: 'Shorthand for highpass filter.',
    signatures: [{
      label: 'hp(value)',
      parameters: [{ label: 'value', documentation: 'Highpass filter value' }],
    }],
  },
  {
    name: 'hpa',
    detail: 'Highpass attack',
    documentation: 'Shorthand for highpass attack.',
    signatures: [{
      label: 'hpa(value)',
      parameters: [{ label: 'value', documentation: 'Highpass attack value' }],
    }],
  },
  {
    name: 'hpd',
    detail: 'Highpass decay',
    documentation: 'Shorthand for highpass decay.',
    signatures: [{
      label: 'hpd(value)',
      parameters: [{ label: 'value', documentation: 'Highpass decay value' }],
    }],
  },
  {
    name: 'hpe',
    detail: 'Highpass env',
    documentation: 'Shorthand for highpass env.',
    signatures: [{
      label: 'hpe(value)',
      parameters: [{ label: 'value', documentation: 'Highpass env value' }],
    }],
  },
  {
    name: 'hpr',
    detail: 'Highpass release',
    documentation: 'Shorthand for highpass release.',
    signatures: [{
      label: 'hpr(value)',
      parameters: [{ label: 'value', documentation: 'Highpass release value' }],
    }],
  },
  {
    name: 'hps',
    detail: 'Highpass sustain',
    documentation: 'Shorthand for highpass sustain.',
    signatures: [{
      label: 'hps(value)',
      parameters: [{ label: 'value', documentation: 'Highpass sustain value' }],
    }],
  },
  {
    name: 'hsl',
    detail: 'HSL color',
    documentation: 'Shorthand for HSL color.',
    signatures: [{
      label: 'hsl(value)',
      parameters: [{ label: 'value', documentation: 'HSL color value' }],
    }],
  },
  {
    name: 'id',
    detail: 'Identity function',
    documentation: 'Returns its input unchanged. Functional programming utility.',
    signatures: [{
      label: 'id(value)',
      parameters: [{ label: 'value', documentation: 'Value to return' }],
    }],
  },
  {
    name: 'inv',
    detail: 'Invert',
    documentation: 'Shorthand for invert.',
    signatures: [{
      label: 'inv(value)',
      parameters: [{ label: 'value', documentation: 'Invert value' }],
    }],
  },
  {
    name: 'ir',
    detail: 'Impulse response',
    documentation: 'Shorthand for impulse response.',
    signatures: [{
      label: 'ir(value)',
      parameters: [{ label: 'value', documentation: 'Impulse response value' }],
    }],
  },
  {
    name: 'lfo',
    detail: 'Low frequency oscillator',
    documentation: 'Shorthand for low frequency oscillator.',
    signatures: [{
      label: 'lfo(value)',
      parameters: [{ label: 'value', documentation: 'Low frequency oscillator value' }],
    }],
  },
  {
    name: 'lp',
    detail: 'Lowpass filter',
    documentation: 'Shorthand for lowpass filter.',
    signatures: [{
      label: 'lp(value)',
      parameters: [{ label: 'value', documentation: 'Lowpass filter value' }],
    }],
  },
  {
    name: 'lpa',
    detail: 'Lowpass attack',
    documentation: 'Shorthand for lowpass attack.',
    signatures: [{
      label: 'lpa(value)',
      parameters: [{ label: 'value', documentation: 'Lowpass attack value' }],
    }],
  },
  {
    name: 'lpd',
    detail: 'Lowpass decay',
    documentation: 'Shorthand for lowpass decay.',
    signatures: [{
      label: 'lpd(value)',
      parameters: [{ label: 'value', documentation: 'Lowpass decay value' }],
    }],
  },
  {
    name: 'lpe',
    detail: 'Lowpass env',
    documentation: 'Shorthand for lowpass env.',
    signatures: [{
      label: 'lpe(value)',
      parameters: [{ label: 'value', documentation: 'Lowpass env value' }],
    }],
  },
  {
    name: 'lpr',
    detail: 'Lowpass release',
    documentation: 'Shorthand for lowpass release.',
    signatures: [{
      label: 'lpr(value)',
      parameters: [{ label: 'value', documentation: 'Lowpass release value' }],
    }],
  },
  {
    name: 'lps',
    detail: 'Lowpass sustain',
    documentation: 'Shorthand for lowpass sustain.',
    signatures: [{
      label: 'lps(value)',
      parameters: [{ label: 'value', documentation: 'Lowpass sustain value' }],
    }],
  },
  {
    name: 'lt',
    detail: 'Less than',
    documentation: 'Shorthand for less than.',
    signatures: [{
      label: 'lt(value)',
      parameters: [{ label: 'value', documentation: 'Less than value' }],
    }],
  },
  {
    name: 'lte',
    detail: 'Less than or equal',
    documentation: 'Shorthand for less than or equal.',
    signatures: [{
      label: 'lte(value)',
      parameters: [{ label: 'value', documentation: 'Less than or equal value' }],
    }],
  },
  {
    name: 'm',
    detail: 'Mode/midi',
    documentation: 'Shorthand for mode/midi.',
    signatures: [{
      label: 'm(value)',
      parameters: [{ label: 'value', documentation: 'Mode/midi value' }],
    }],
  },
  {
    name: 'mod',
    detail: 'Modulation',
    documentation: 'Shorthand for modulation.',
    signatures: [{
      label: 'mod(value)',
      parameters: [{ label: 'value', documentation: 'Modulation value' }],
    }],
  },
  {
    name: 'ne',
    detail: 'Not equal',
    documentation: 'Shorthand for not equal.',
    signatures: [{
      label: 'ne(value)',
      parameters: [{ label: 'value', documentation: 'Not equal value' }],
    }],
  },
  {
    name: 'net',
    detail: 'Network',
    documentation: 'Shorthand for network.',
    signatures: [{
      label: 'net(value)',
      parameters: [{ label: 'value', documentation: 'Network value' }],
    }],
  },
  {
    name: 'or',
    detail: 'Bitwise OR',
    documentation: 'Shorthand for bitwise OR.',
    signatures: [{
      label: 'or(value)',
      parameters: [{ label: 'value', documentation: 'Bitwise OR value' }],
    }],
  },
  {
    name: 'ph',
    detail: 'Phase',
    documentation: 'Shorthand for phase.',
    signatures: [{
      label: 'ph(value)',
      parameters: [{ label: 'value', documentation: 'Phase value' }],
    }],
  },
  {
    name: 'phc',
    detail: 'Phaser center',
    documentation: 'Shorthand for phaser center.',
    signatures: [{
      label: 'phc(value)',
      parameters: [{ label: 'value', documentation: 'Phaser center value' }],
    }],
  },
  {
    name: 'phd',
    detail: 'Phaser depth',
    documentation: 'Shorthand for phaser depth.',
    signatures: [{
      label: 'phd(value)',
      parameters: [{ label: 'value', documentation: 'Phaser depth value' }],
    }],
  },
  {
    name: 'phs',
    detail: 'Phaser sweep',
    documentation: 'Shorthand for phaser sweep.',
    signatures: [{
      label: 'phs(value)',
      parameters: [{ label: 'value', documentation: 'Phaser sweep value' }],
    }],
  },
  {
    name: 'pm',
    detail: 'Phase modulation',
    documentation: 'Shorthand for phase modulation.',
    signatures: [{
      label: 'pm(value)',
      parameters: [{ label: 'value', documentation: 'Phase modulation value' }],
    }],
  },
  {
    name: 'pow',
    detail: 'Power',
    documentation: 'Shorthand for power.',
    signatures: [{
      label: 'pow(value)',
      parameters: [{ label: 'value', documentation: 'Power value' }],
    }],
  },
  {
    name: 'pr',
    detail: 'Pattern reference',
    documentation: 'Shorthand for pattern reference.',
    signatures: [{
      label: 'pr(value)',
      parameters: [{ label: 'value', documentation: 'Pattern reference value' }],
    }],
  },
  {
    name: 'ref',
    detail: 'Reference',
    documentation: 'Shorthand for reference.',
    signatures: [{
      label: 'ref(value)',
      parameters: [{ label: 'value', documentation: 'Reference value' }],
    }],
  },
  {
    name: 'rel',
    detail: 'Release',
    documentation: 'Shorthand for release.',
    signatures: [{
      label: 'rel(value)',
      parameters: [{ label: 'value', documentation: 'Release value' }],
    }],
  },
  {
    name: 'rib',
    detail: 'Ribbon controller',
    documentation: 'Shorthand for ribbon controller.',
    signatures: [{
      label: 'rib(value)',
      parameters: [{ label: 'value', documentation: 'Ribbon controller value' }],
    }],
  },
  {
    name: 'rlp',
    detail: 'Resonant lowpass',
    documentation: 'Shorthand for resonant lowpass.',
    signatures: [{
      label: 'rlp(value)',
      parameters: [{ label: 'value', documentation: 'Resonant lowpass value' }],
    }],
  },
  {
    name: 'seg',
    detail: 'Segment',
    documentation: 'Shorthand for segment.',
    signatures: [{
      label: 'seg(value)',
      parameters: [{ label: 'value', documentation: 'Segment value' }],
    }],
  },
  {
    name: 'src',
    detail: 'Source',
    documentation: 'Shorthand for source.',
    signatures: [{
      label: 'src(value)',
      parameters: [{ label: 'value', documentation: 'Source value' }],
    }],
  },
  {
    name: 'sus',
    detail: 'Sustain',
    documentation: 'Shorthand for sustain.',
    signatures: [{
      label: 'sus(value)',
      parameters: [{ label: 'value', documentation: 'Sustain value' }],
    }],
  },
  {
    name: 'sz',
    detail: 'Size',
    documentation: 'Shorthand for size.',
    signatures: [{
      label: 'sz(value)',
      parameters: [{ label: 'value', documentation: 'Size value' }],
    }],
  },
  {
    name: 'uid',
    detail: 'Unique id',
    documentation: 'Shorthand for unique id.',
    signatures: [{
      label: 'uid(value)',
      parameters: [{ label: 'value', documentation: 'Unique id value' }],
    }],
  },
  {
    name: 'v',
    detail: 'Velocity/value',
    documentation: 'Shorthand for velocity/value.',
    signatures: [{
      label: 'v(value)',
      parameters: [{ label: 'value', documentation: 'Velocity/value value' }],
    }],
  },
  {
    name: 'val',
    detail: 'Value',
    documentation: 'Shorthand for value.',
    signatures: [{
      label: 'val(value)',
      parameters: [{ label: 'value', documentation: 'Value value' }],
    }],
  },
  {
    name: 'zip',
    detail: 'Zip steps together',
    documentation: 'Zips together the steps of provided patterns. Creates a dense cycle. Use pace() to control playback speed. Experimental.',
    signatures: [{
      label: 'zip(...pats)',
      parameters: [],
    }],
  },

  // === EFFECTS ===
  {
    name: 'compose',
    detail: 'Compose functions',
    documentation: 'Composes functions right-to-left. Functional programming utility.',
    signatures: [{
      label: 'compose(...fns)',
      parameters: [],
    }],
  },
  {
    name: 'compressSpan',
    detail: 'Compress time span',
    documentation: 'Compress time span.',
    signatures: [{
      label: 'compressSpan(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'compressorAttack',
    detail: 'Compressor attack time',
    documentation: 'Compressor attack time.',
    signatures: [{
      label: 'compressorAttack(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'compressorKnee',
    detail: 'Compressor knee',
    documentation: 'Compressor knee.',
    signatures: [{
      label: 'compressorKnee(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'compressorRatio',
    detail: 'Compressor ratio',
    documentation: 'Compressor ratio.',
    signatures: [{
      label: 'compressorRatio(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'compressorRelease',
    detail: 'Compressor release time',
    documentation: 'Compressor release time.',
    signatures: [{
      label: 'compressorRelease(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'compressspan',
    detail: 'Compress time span',
    documentation: 'Compress time span.',
    signatures: [{
      label: 'compressspan(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'delayfb',
    detail: 'Delay feedback',
    documentation: 'Delay feedback.',
    signatures: [{
      label: 'delayfb(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'delayt',
    detail: 'Delay time',
    documentation: 'Delay time.',
    signatures: [{
      label: 'delayt(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'dist',
    detail: 'Distortion effect',
    documentation: 'Distortion effect.',
    signatures: [{
      label: 'dist(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'duck',
    detail: 'Ducking/sidechain compression',
    documentation: 'Ducking/sidechain compression.',
    signatures: [{
      label: 'duck(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'freeze',
    detail: 'Freeze/granular freeze effect',
    documentation: 'Freeze/granular freeze effect.',
    signatures: [{
      label: 'freeze(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'fshift',
    detail: 'Frequency shift',
    documentation: 'Frequency shift.',
    signatures: [{
      label: 'fshift(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'fshiftnote',
    detail: 'Frequency shift by note',
    documentation: 'Frequency shift by note.',
    signatures: [{
      label: 'fshiftnote(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'fshiftphase',
    detail: 'Frequency shift phase',
    documentation: 'Frequency shift phase.',
    signatures: [{
      label: 'fshiftphase(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'morph',
    detail: 'Morph between patterns',
    documentation: 'Morph between patterns.',
    signatures: [{
      label: 'morph(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'phaserrate',
    detail: 'Phaser rate',
    documentation: 'Phaser rate.',
    signatures: [{
      label: 'phaserrate(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'ring',
    detail: 'Ring modulation',
    documentation: 'Ring modulation.',
    signatures: [{
      label: 'ring(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'ringdf',
    detail: 'Ring modulator dry/wet',
    documentation: 'Ring modulator dry/wet.',
    signatures: [{
      label: 'ringdf(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },
  {
    name: 'ringf',
    detail: 'Ring modulator frequency',
    documentation: 'Ring modulator frequency.',
    signatures: [{
      label: 'ringf(value)',
      parameters: [{ label: 'value', documentation: 'Effect parameter value' }],
    }],
  },

  // === OTHER STRUDEL FUNCTIONS (minimal documentation) ===
  {
    name: 'activeLabel',
    detail: 'Active label state',
    documentation: 'Internal function for managing active label state in the pattern system. Used for pattern identification and labeling.',
    signatures: [{
      label: 'activeLabel(label)',
      parameters: [{ label: 'label', documentation: 'Label identifier' }],
    }],
  },
  {
    name: 'analyze',
    detail: 'Audio analysis',
    documentation: 'Performs audio analysis (FFT) on the pattern.',
    signatures: [{
      label: 'analyze(options)',
      parameters: [{ label: 'options', documentation: 'Analysis options' }],
    }],
  },
  {
    name: 'applyN',
    detail: 'Apply function N times',
    documentation: 'Applies a function to a pattern N times. Useful for building up transformations iteratively.',
    signatures: [{
      label: 'applyN(n, fn)',
      parameters: [
        { label: 'n', documentation: 'Number of times to apply' },
        { label: 'fn', documentation: 'Function to apply' },
      ],
    }],
  },
  {
    name: 'arpWith',
    detail: 'Arpeggiate with function',
    documentation: 'Selects indices in stacked notes using a custom function. Experimental.',
    signatures: [{
      label: 'arpWith(fn)',
      parameters: [{ label: 'fn', documentation: 'Function that receives haps array and returns selected hap(s)' }],
    }],
  },
  {
    name: 'backgroundImage',
    detail: 'Background image',
    documentation: 'Sets a background image for visualization.',
    signatures: [{
      label: 'backgroundImage(url)',
      parameters: [{ label: 'url', documentation: 'Image URL' }],
    }],
  },
  {
    name: 'band',
    detail: 'Bitwise AND',
    documentation: 'Bitwise AND operation on pattern values. Combines two patterns using binary AND.',
    signatures: [{
      label: 'band(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern to AND with' }],
    }],
  },
  {
    name: 'bandf',
    detail: 'Synonym for bpf',
    documentation: 'Bandpass filter center frequency. Synonym for bpf.',
    signatures: [{
      label: 'bandf(frequency)',
      parameters: [{ label: 'frequency', documentation: 'Center frequency in Hz' }],
    }],
  },
  {
    name: 'bandq',
    detail: 'Synonym for bpq',
    documentation: 'Bandpass filter Q-factor (resonance). Synonym for bpq.',
    signatures: [{
      label: 'bandq(q)',
      parameters: [{ label: 'q', documentation: 'Q-factor value' }],
    }],
  },
  {
    name: 'base64ToUnicode',
    detail: 'Decode base64 to unicode (internal)',
    documentation: 'Internal utility function. Decodes a base64 string to unicode text. Used for code sharing/compression.',
    signatures: [{
      label: 'base64ToUnicode(base64)',
      parameters: [{ label: 'base64', documentation: 'Base64 encoded string' }],
    }],
  },
  {
    name: 'bbexpr',
    detail: 'Bytebeat expression',
    documentation: 'Alias for byteBeatExpression - sets the bytebeat expression formula for audio synthesis.',
    signatures: [{
      label: 'bbexpr(expression)',
      parameters: [{ label: 'expression', documentation: 'Bytebeat expression string, e.g. "t*(t>>8|t>>9)&46&t>>8"' }],
    }],
  },
  {
    name: 'bbst',
    detail: 'Bytebeat start time',
    documentation: 'Alias for byteBeatStartTime - sets the start time offset for bytebeat synthesis.',
    signatures: [{
      label: 'bbst(time)',
      parameters: [{ label: 'time', documentation: 'Start time offset' }],
    }],
  },
  {
    name: 'berlinWith',
    detail: 'Berlin school sequencer',
    documentation: 'Berlin school style sequencer with custom function. Creates evolving patterns typical of Berlin school electronic music.',
    signatures: [{
      label: 'berlinWith(fn, pattern)',
      parameters: [
        { label: 'fn', documentation: 'Function to apply' },
        { label: 'pattern', documentation: 'Base pattern' },
      ],
    }],
  },
  {
    name: 'bind',
    detail: 'Monadic bind',
    documentation: 'Functional programming bind/flatMap operation. Applies a function that returns a pattern to each value and flattens the result.',
    signatures: [{
      label: 'bind(fn)',
      parameters: [{ label: 'fn', documentation: 'Function that takes a value and returns a pattern' }],
    }],
  },
  {
    name: 'binshift',
    detail: 'Binary shift',
    documentation: 'Binary shift operation on pattern values.',
    signatures: [{
      label: 'binshift(amount)',
      parameters: [{ label: 'amount', documentation: 'Number of bits to shift' }],
    }],
  },
  {
    name: 'bjork',
    detail: 'Bjorklund algorithm',
    documentation: 'Creates Euclidean patterns using Bjorklund algorithm.',
    signatures: [{
      label: 'bjork(pulses, steps)',
      parameters: [
        { label: 'pulses', documentation: 'Number of pulses' },
        { label: 'steps', documentation: 'Number of steps' }
      ],
    }],
  },
  {
    name: 'blshift',
    detail: 'Binary left shift',
    documentation: 'Binary left shift operation on pattern values.',
    signatures: [{
      label: 'blshift(amount)',
      parameters: [{ label: 'amount', documentation: 'Number of bits to shift left' }],
    }],
  },
  {
    name: 'brak',
    detail: 'Breakbeat pattern',
    documentation: 'Squashes the pattern to fit half a cycle, then plays it off-beat with the other half.',
    signatures: [{
      label: 'brak(pat)',
      parameters: [{ label: 'pat', documentation: 'Pattern to apply breakbeat effect to' }],
    }],
  },
  {
    name: 'brshift',
    detail: 'Binary right shift',
    documentation: 'Binary right shift operation on pattern values.',
    signatures: [{
      label: 'brshift(amount)',
      parameters: [{ label: 'amount', documentation: 'Number of bits to shift right' }],
    }],
  },
  {
    name: 'bxor',
    detail: 'Bitwise XOR',
    documentation: 'Bitwise XOR (exclusive or) operation on pattern values.',
    signatures: [{
      label: 'bxor(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern to XOR with' }],
    }],
  },
  {
    name: 'bypass',
    detail: 'Bypass effects',
    documentation: 'Bypasses audio effects when true.',
    signatures: [{
      label: 'bypass(toggle)',
      parameters: [{ label: 'toggle', documentation: 'Bypass on/off' }],
    }],
  },
  {
    name: 'calculateSteps',
    detail: 'Calculate pattern steps (internal)',
    documentation: 'Internal utility function. Calculates the number of steps in a pattern. Used for pattern analysis and visualization.',
    signatures: [{
      label: 'calculateSteps(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern to analyze' }],
    }],
  },
  {
    name: 'channel',
    detail: 'MIDI channel',
    documentation: 'Sets the MIDI channel for output (1-16).',
    signatures: [{
      label: 'channel(n)',
      parameters: [{ label: 'n', documentation: 'MIDI channel number (1-16)' }],
    }],
  },
  {
    name: 'chooseIn',
    detail: 'Choose by input index',
    documentation: 'Chooses from values based on input pattern.',
    signatures: [{
      label: 'chooseIn(pat, ...xs)',
      parameters: [{ label: 'pat', documentation: 'Pattern of indices' }],
    }],
  },
  {
    name: 'chooseInWith',
    detail: 'Choose in with function',
    documentation: 'Like chooseIn, but uses a custom function.',
    signatures: [{
      label: 'chooseInWith(fn, ...xs)',
      parameters: [{ label: 'fn', documentation: 'Function to determine selection' }],
    }],
  },
  {
    name: 'chooseOut',
    detail: 'Choose from output',
    documentation: 'Outputs a randomly chosen value from the list.',
    signatures: [{
      label: 'chooseOut(...xs)',
      parameters: [],
    }],
  },
  {
    name: 'chooseWith',
    detail: 'Choose with function',
    documentation: 'Like choose, but uses a custom function to pick from values.',
    signatures: [{
      label: 'chooseWith(fn, ...xs)',
      parameters: [{ label: 'fn', documentation: 'Function to determine selection' }],
    }],
  },
  {
    name: 'chunkBack',
    detail: 'Chunk backwards',
    documentation: 'Like chunk, but cycles through the parts in reverse order. Known as chunk\' in TidalCycles.',
    signatures: [{
      label: 'chunkBack(n, fn)',
      parameters: [
        { label: 'n', documentation: 'Number of parts to divide pattern into' },
        { label: 'fn', documentation: 'Function to apply to each part' }
      ],
    }],
  },
  {
    name: 'chunkback',
    detail: 'Chunk backwards',
    documentation: 'Alias for chunkBack. Like chunk, but cycles through the parts in reverse order.',
    signatures: [{
      label: 'chunkback(n, fn)',
      parameters: [
        { label: 'n', documentation: 'Number of parts to divide pattern into' },
        { label: 'fn', documentation: 'Function to apply to each part' }
      ],
    }],
  },
  {
    name: 'clamp',
    detail: 'Clamp value',
    documentation: 'Clamps a value between min and max. Standard JavaScript utility.',
    signatures: [{
      label: 'clamp(value, min, max)',
      parameters: [{ label: 'value', documentation: 'Value to clamp' }, { label: 'min', documentation: 'Minimum value' }, { label: 'max', documentation: 'Maximum value' }],
    }],
  },
  {
    name: 'code2hash',
    detail: 'Code to URL hash (internal)',
    documentation: 'Internal utility function. Converts Strudel code to a compressed URL hash for sharing. Used in the web REPL.',
    signatures: [{
      label: 'code2hash(code)',
      parameters: [{ label: 'code', documentation: 'Strudel code to compress' }],
    }],
  },
  {
    name: 'comb',
    detail: 'Comb filter',
    documentation: 'Applies a comb filter effect.',
    signatures: [{
      label: 'comb(freq)',
      parameters: [{ label: 'freq', documentation: 'Comb filter frequency' }],
    }],
  },
  {
    name: 'constant',
    detail: 'Constant function',
    documentation: 'Returns a function that always returns the given value. Functional programming utility.',
    signatures: [{
      label: 'constant(value)',
      parameters: [{ label: 'value', documentation: 'Value to always return' }],
    }],
  },
  {
    name: 'contract',
    detail: 'Contract step size',
    documentation: 'Contracts the step size of the pattern by the given factor. Experimental stepwise function. See also expand.',
    signatures: [{
      label: 'contract(factor)',
      parameters: [{ label: 'factor', documentation: 'Factor to contract steps by' }],
    }],
  },
  {
    name: 'ctlNum',
    detail: 'MIDI control number',
    documentation: 'Sets the MIDI control change number.',
    signatures: [{
      label: 'ctlNum(n)',
      parameters: [{ label: 'n', documentation: 'Control number (0-127)' }],
    }],
  },
  {
    name: 'ctranspose',
    detail: 'Chromatic transpose',
    documentation: 'Transposes note chromatically (in semitones).',
    signatures: [{
      label: 'ctranspose(semitones)',
      parameters: [{ label: 'semitones', documentation: 'Number of semitones to transpose' }],
    }],
  },
  {
    name: 'curve',
    detail: 'Curve modifier',
    documentation: 'Applies a curve transformation to values.',
    signatures: [{
      label: 'curve(exponent)',
      parameters: [{ label: 'exponent', documentation: 'Curve exponent' }],
    }],
  },
  {
    name: 'cutoff',
    detail: 'Synonym for lpf',
    documentation: 'Lowpass filter cutoff frequency. Synonym for lpf.',
    signatures: [{
      label: 'cutoff(frequency)',
      parameters: [{ label: 'frequency', documentation: 'Cutoff frequency in Hz (0-20000)' }],
    }],
  },
  {
    name: 'cycleToSeconds',
    detail: 'Cycles to seconds',
    documentation: 'Converts cycle time to seconds based on current tempo.',
    signatures: [{
      label: 'cycleToSeconds(cycles)',
      parameters: [{ label: 'cycles', documentation: 'Number of cycles' }],
    }],
  },
  {
    name: 'degradeByWith',
    detail: 'Degrade with custom random',
    documentation: 'Like degradeBy but uses a custom random function.',
    signatures: [{
      label: 'degradeByWith(fn, amount)',
      parameters: [
        { label: 'fn', documentation: 'Random function' },
        { label: 'amount', documentation: 'Probability of removal (0-1)' }
      ],
    }],
  },
  {
    name: 'degree',
    detail: 'Scale degree',
    documentation: 'Selects a scale degree from the current scale.',
    signatures: [{
      label: 'degree(n)',
      parameters: [{ label: 'n', documentation: 'Scale degree (1-based)' }],
    }],
  },
  {
    name: 'deltaSlide',
    detail: 'Delta slide',
    documentation: 'Adds pitch slide delta over time.',
    signatures: [{
      label: 'deltaSlide(amount)',
      parameters: [{ label: 'amount', documentation: 'Slide delta amount' }],
    }],
  },
  {
    name: 'dict',
    detail: 'Voicing dictionary',
    documentation: 'Sets the voicing dictionary to use for chord voicings.',
    signatures: [{
      label: 'dict(name)',
      parameters: [{ label: 'name', documentation: 'Dictionary name (e.g., "lefthand", "ireal")' }],
    }],
  },
  {
    name: 'dictionary',
    detail: 'Create sample dictionary',
    documentation: 'Creates a dictionary mapping names to sample banks or sounds. Used for organizing and accessing samples.',
    signatures: [{
      label: 'dictionary(mapping)',
      parameters: [{ label: 'mapping', documentation: 'Object mapping names to sample paths/banks' }],
    }],
  },
  {
    name: 'drawLine',
    detail: 'Draw line visualization',
    documentation: 'Draws a line visualization of the pattern.',
    signatures: [{
      label: 'drawLine(options)',
      parameters: [{ label: 'options', documentation: 'Drawing options' }],
    }],
  },
  {
    name: 'drop',
    detail: 'Drop steps',
    documentation: 'Drops the given number of steps from a pattern. Positive drops from start, negative drops from end. Experimental stepwise function.',
    signatures: [{
      label: 'drop(n)',
      parameters: [{ label: 'n', documentation: 'Number of steps to drop (positive=start, negative=end)' }],
    }],
  },
  {
    name: 'eish',
    detail: 'Equal interval scale halftone',
    documentation: 'Xeno-harmonic tuning function. Sets the equal interval scale halftone/semitone size. Used for microtonal and alternative tuning systems.',
    signatures: [{
      label: 'eish(semitoneRatio)',
      parameters: [{ label: 'semitoneRatio', documentation: 'Ratio for each semitone step' }],
    }],
  },
  {
    name: 'enhance',
    detail: 'Audio enhancer',
    documentation: 'Enhances audio clarity/presence.',
    signatures: [{
      label: 'enhance(amount)',
      parameters: [{ label: 'amount', documentation: 'Enhancement amount' }],
    }],
  },
  {
    name: 'euclidRot',
    detail: 'Euclidean rhythm with rotation',
    documentation: 'Like euclid, but has an additional parameter for rotating the resulting sequence.',
    signatures: [{
      label: 'euclidRot(pulses, steps, rotation)',
      parameters: [
        { label: 'pulses', documentation: 'Number of onsets/beats' },
        { label: 'steps', documentation: 'Number of steps to fill' },
        { label: 'rotation', documentation: 'Offset in steps' }
      ],
    }],
  },
  {
    name: 'euclidrot',
    detail: 'Euclidean rhythm with rotation',
    documentation: 'Alias for euclidRot. Like euclid with rotation.',
    signatures: [{
      label: 'euclidrot(pulses, steps, rotation)',
      parameters: [
        { label: 'pulses', documentation: 'Number of onsets/beats' },
        { label: 'steps', documentation: 'Number of steps to fill' },
        { label: 'rotation', documentation: 'Offset in steps' }
      ],
    }],
  },
  {
    name: 'expand',
    detail: 'Expand step size',
    documentation: 'Expands the step size of the pattern by the given factor. Experimental stepwise function.',
    signatures: [{
      label: 'expand(factor)',
      parameters: [{ label: 'factor', documentation: 'Factor to expand steps by' }],
    }],
  },
  {
    name: 'expression',
    detail: 'Mathematical expression',
    documentation: 'Evaluates a mathematical expression as a pattern. Can be used for dynamic value generation.',
    signatures: [{
      label: 'expression(expr)',
      parameters: [{ label: 'expr', documentation: 'Mathematical expression string' }],
    }],
  },
  {
    name: 'extend',
    detail: 'Extend pattern',
    documentation: 'Like fast but also increases step count accordingly. Stepwise alternative to fast.',
    signatures: [{
      label: 'extend(factor)',
      parameters: [{ label: 'factor', documentation: 'Factor to extend by' }],
    }],
  },
  {
    name: 'fadeInTime',
    detail: 'Fade in time',
    documentation: 'Fade in time for the sound in seconds.',
    signatures: [{
      label: 'fadeInTime(seconds)',
      parameters: [{ label: 'seconds', documentation: 'Fade in duration' }],
    }],
  },
  {
    name: 'fadeOutTime',
    detail: 'Fade out time',
    documentation: 'Fade out time for the sound in seconds.',
    signatures: [{
      label: 'fadeOutTime(seconds)',
      parameters: [{ label: 'seconds', documentation: 'Fade out duration' }],
    }],
  },
  {
    name: 'fadeTime',
    detail: 'Fade time',
    documentation: 'Sets both fade in and fade out time.',
    signatures: [{
      label: 'fadeTime(seconds)',
      parameters: [{ label: 'seconds', documentation: 'Fade duration' }],
    }],
  },
  {
    name: 'filter',
    detail: 'Filter pattern',
    documentation: 'Filters events in a pattern based on a predicate function.',
    signatures: [{
      label: 'filter(fn)',
      parameters: [{ label: 'fn', documentation: 'Predicate function' }],
    }],
  },
  {
    name: 'flatten',
    detail: 'Flatten array',
    documentation: 'Flattens a nested array by one level. Standard JavaScript utility.',
    signatures: [{
      label: 'flatten(array)',
      parameters: [{ label: 'array', documentation: 'Array to flatten' }],
    }],
  },
  {
    name: 'fmrelease',
    detail: 'FM release time',
    documentation: 'FM synth release time.',
    signatures: [{
      label: 'fmrelease(time)',
      parameters: [{ label: 'time', documentation: 'Release time in seconds' }],
    }],
  },
  {
    name: 'fmvelocity',
    detail: 'FM velocity sensitivity',
    documentation: 'FM synth velocity sensitivity.',
    signatures: [{
      label: 'fmvelocity(amount)',
      parameters: [{ label: 'amount', documentation: 'Velocity sensitivity' }],
    }],
  },
  {
    name: 'focusSpan',
    detail: 'Focus on time span',
    documentation: 'Focuses the pattern query on a specific time span. Similar to zoom but works with absolute time spans rather than factors.',
    signatures: [{
      label: 'focusSpan(begin, end)',
      parameters: [
        { label: 'begin', documentation: 'Start time of the span' },
        { label: 'end', documentation: 'End time of the span' },
      ],
    }],
  },
  {
    name: 'focusspan',
    detail: 'Focus on time span',
    documentation: 'Alias for focusSpan. Focuses the pattern query on a specific time span.',
    signatures: [{
      label: 'focusspan(begin, end)',
      parameters: [
        { label: 'begin', documentation: 'Start time of the span' },
        { label: 'end', documentation: 'End time of the span' },
      ],
    }],
  },
  {
    name: 'fractionalArgs',
    detail: 'Fractional arguments (internal)',
    documentation: 'Internal function for handling fractional arguments in pattern functions. Parses fractional notation.',
    signatures: [{
      label: 'fractionalArgs(args)',
      parameters: [{ label: 'args', documentation: 'Arguments to parse' }],
    }],
  },
  {
    name: 'frameRate',
    detail: 'Frame rate',
    documentation: 'Sets the visualization frame rate.',
    signatures: [{
      label: 'frameRate(fps)',
      parameters: [{ label: 'fps', documentation: 'Frames per second' }],
    }],
  },
  {
    name: 'frames',
    detail: 'Frame count',
    documentation: 'Sets the number of frames for visualization.',
    signatures: [{
      label: 'frames(n)',
      parameters: [{ label: 'n', documentation: 'Number of frames' }],
    }],
  },
  {
    name: 'freqToMidi',
    detail: 'Frequency to MIDI',
    documentation: 'Converts a frequency in Hz to a MIDI note number.',
    signatures: [{
      label: 'freqToMidi(freq)',
      parameters: [{ label: 'freq', documentation: 'Frequency in Hz' }],
    }],
  },
  {
    name: 'fromBipolar',
    detail: 'Convert from bipolar',
    documentation: 'Converts a bipolar value (-1 to 1) to unipolar (0 to 1).',
    signatures: [{
      label: 'fromBipolar(value)',
      parameters: [{ label: 'value', documentation: 'Bipolar value (-1 to 1)' }],
    }],
  },
  {
    name: 'func',
    detail: 'Function wrapper',
    documentation: 'Wraps a JavaScript function for use in patterns. Allows custom functions to work with the pattern system.',
    signatures: [{
      label: 'func(fn)',
      parameters: [{ label: 'fn', documentation: 'JavaScript function to wrap' }],
    }],
  },
  {
    name: 'grow',
    detail: 'Grow pattern progressively',
    documentation: 'Progressively grows the pattern by n steps until the full pattern is played. Positive grows from start, negative from end. Experimental.',
    signatures: [{
      label: 'grow(n)',
      parameters: [{ label: 'n', documentation: 'Number of steps to grow by each cycle' }],
    }],
  },
  {
    name: 'harmonic',
    detail: 'Harmonic series',
    documentation: 'Adds harmonic overtones to the sound.',
    signatures: [{
      label: 'harmonic(n)',
      parameters: [{ label: 'n', documentation: 'Harmonic number' }],
    }],
  },
  {
    name: 'hash2code',
    detail: 'URL hash to code (internal)',
    documentation: 'Internal utility function. Decompresses a URL hash back to Strudel code. Used in the web REPL.',
    signatures: [{
      label: 'hash2code(hash)',
      parameters: [{ label: 'hash', documentation: 'Compressed URL hash' }],
    }],
  },
  {
    name: 'hbrick',
    detail: 'Spectral high brick',
    documentation: 'SuperDirt spectral effect - brick wall filter for high frequencies. Removes frequencies above the threshold.',
    signatures: [{
      label: 'hbrick(threshold)',
      parameters: [{ label: 'threshold', documentation: 'Frequency threshold (0-1)' }],
    }],
  },
  {
    name: 'hcutoff',
    detail: 'Synonym for hpf',
    documentation: 'Highpass filter cutoff frequency. Synonym for hpf.',
    signatures: [{
      label: 'hcutoff(frequency)',
      parameters: [{ label: 'frequency', documentation: 'Cutoff frequency in Hz (0-20000)' }],
    }],
  },
  {
    name: 'hours',
    detail: 'Hours signal',
    documentation: 'Returns the current time in hours.',
    signatures: [{
      label: 'hours',
      parameters: [],
    }],
  },
  {
    name: 'hresonance',
    detail: 'Synonym for hpq',
    documentation: 'Highpass filter resonance (Q-value). Synonym for hpq.',
    signatures: [{
      label: 'hresonance(q)',
      parameters: [{ label: 'q', documentation: 'Resonance factor (0-50)' }],
    }],
  },
  {
    name: 'hsla',
    detail: 'HSLA color',
    documentation: 'Sets visualization color in HSLA format.',
    signatures: [{
      label: 'hsla(h, s, l, a)',
      parameters: [
        { label: 'h', documentation: 'Hue (0-360)' },
        { label: 's', documentation: 'Saturation (0-100)' },
        { label: 'l', documentation: 'Lightness (0-100)' },
        { label: 'a', documentation: 'Alpha (0-1)' }
      ],
    }],
  },
  {
    name: 'imag',
    detail: 'Imaginary component',
    documentation: 'Extracts or sets the imaginary component of complex numbers. Used for spectral/FFT operations.',
    signatures: [{
      label: 'imag(value)',
      parameters: [{ label: 'value', documentation: 'Imaginary component value' }],
    }],
  },
  {
    name: 'kcutoff',
    detail: 'Karplus cutoff frequency',
    documentation: 'Sets the cutoff frequency for Karplus-Strong string synthesis algorithm.',
    signatures: [{
      label: 'kcutoff(frequency)',
      parameters: [{ label: 'frequency', documentation: 'Cutoff frequency in Hz' }],
    }],
  },
  {
    name: 'keep',
    detail: 'Keep events',
    documentation: 'Keeps only events that match the predicate.',
    signatures: [{
      label: 'keep(fn)',
      parameters: [{ label: 'fn', documentation: 'Predicate function' }],
    }],
  },
  {
    name: 'keepif',
    detail: 'Keep if condition',
    documentation: 'Keeps events only when condition is true.',
    signatures: [{
      label: 'keepif(condition)',
      parameters: [{ label: 'condition', documentation: 'Condition pattern' }],
    }],
  },
  {
    name: 'krush',
    detail: 'Bit crush effect',
    documentation: 'Bit-crusher distortion effect. Reduces bit depth.',
    signatures: [{
      label: 'krush(amount)',
      parameters: [{ label: 'amount', documentation: 'Crush amount (higher = more distortion)' }],
    }],
  },
  {
    name: 'lbrick',
    detail: 'Spectral low brick',
    documentation: 'SuperDirt spectral effect - brick wall filter for low frequencies. Removes frequencies below the threshold.',
    signatures: [{
      label: 'lbrick(threshold)',
      parameters: [{ label: 'threshold', documentation: 'Frequency threshold (0-1)' }],
    }],
  },
  {
    name: 'listRange',
    detail: 'List range (internal)',
    documentation: 'Internal utility function for creating a range list.',
    signatures: [{
      label: 'listRange(start, end)',
      parameters: [
        { label: 'start', documentation: 'Start value' },
        { label: 'end', documentation: 'End value' },
      ],
    }],
  },
  {
    name: 'logger',
    detail: 'Logger (internal)',
    documentation: 'Internal logging utility for debugging patterns.',
    signatures: [{
      label: 'logger(message)',
      parameters: [{ label: 'message', documentation: 'Message to log' }],
    }],
  },
  {
    name: 'loopb',
    detail: 'Loop begin',
    documentation: 'Sets the loop begin point for sample playback (0-1).',
    signatures: [{
      label: 'loopb(pos)',
      parameters: [{ label: 'pos', documentation: 'Loop begin position (0-1)' }],
    }],
  },
  {
    name: 'loope',
    detail: 'Loop end',
    documentation: 'Sets the loop end point for sample playback (0-1).',
    signatures: [{
      label: 'loope(pos)',
      parameters: [{ label: 'pos', documentation: 'Loop end position (0-1)' }],
    }],
  },
  {
    name: 'lsize',
    detail: 'Leslie size',
    documentation: 'SuperDirt parameter - controls the size/room of the Leslie speaker effect.',
    signatures: [{
      label: 'lsize(size)',
      parameters: [{ label: 'size', documentation: 'Leslie room size' }],
    }],
  },
  {
    name: 'mapArgs',
    detail: 'Map arguments (internal)',
    documentation: 'Internal utility for mapping function arguments.',
    signatures: [{
      label: 'mapArgs(fn, args)',
      parameters: [
        { label: 'fn', documentation: 'Mapping function' },
        { label: 'args', documentation: 'Arguments to map' },
      ],
    }],
  },
  {
    name: 'midi2note',
    detail: 'MIDI to note name',
    documentation: 'Converts a MIDI note number to a note name (e.g., 60 -> "C4").',
    signatures: [{
      label: 'midi2note(midi)',
      parameters: [{ label: 'midi', documentation: 'MIDI note number (0-127)' }],
    }],
  },
  {
    name: 'midiToFreq',
    detail: 'MIDI to frequency',
    documentation: 'Converts a MIDI note number to frequency in Hz.',
    signatures: [{
      label: 'midiToFreq(midi)',
      parameters: [{ label: 'midi', documentation: 'MIDI note number' }],
    }],
  },
  {
    name: 'midimap',
    detail: 'MIDI control mapping',
    documentation: 'Defines or uses a MIDI control mapping. Maps MIDI CC values to pattern parameters.',
    signatures: [{
      label: 'midimap(mapping)',
      parameters: [{ label: 'mapping', documentation: 'MIDI mapping object or name' }],
    }],
  },
  {
    name: 'mini',
    detail: 'Parse mini-notation',
    documentation: 'Parses a mini-notation string and returns a pattern.',
    signatures: [{
      label: 'mini(str)',
      parameters: [{ label: 'str', documentation: 'Mini-notation string' }],
    }],
  },
  {
    name: 'mini2ast',
    detail: 'Mini notation to AST (internal)',
    documentation: 'Internal parser function. Parses mini notation string into an Abstract Syntax Tree. Used by the mini notation parser.',
    signatures: [{
      label: 'mini2ast(miniNotation)',
      parameters: [{ label: 'miniNotation', documentation: 'Mini notation string to parse' }],
    }],
  },
  {
    name: 'miniAllStrings',
    detail: 'Mini notation all strings (internal)',
    documentation: 'Internal parser function. Extracts all string values from mini notation. Used for parsing and analysis.',
    signatures: [{
      label: 'miniAllStrings(miniNotation)',
      parameters: [{ label: 'miniNotation', documentation: 'Mini notation string' }],
    }],
  },
  {
    name: 'minify',
    detail: 'Minify code (internal)',
    documentation: 'Internal utility function. Minifies/compresses Strudel code by removing whitespace and shortening identifiers.',
    signatures: [{
      label: 'minify(code)',
      parameters: [{ label: 'code', documentation: 'Strudel code to minify' }],
    }],
  },
  {
    name: 'minutes',
    detail: 'Minutes signal',
    documentation: 'Returns the current time in minutes.',
    signatures: [{
      label: 'minutes',
      parameters: [],
    }],
  },
  {
    name: 'mtranspose',
    detail: 'Modal transpose',
    documentation: 'Transposes note within the current scale by scale degrees.',
    signatures: [{
      label: 'mtranspose(degrees)',
      parameters: [{ label: 'degrees', documentation: 'Number of scale degrees to transpose' }],
    }],
  },
  {
    name: 'noteToMidi',
    detail: 'Note name to MIDI',
    documentation: 'Converts a note name to a MIDI note number (e.g., "C4" -> 60).',
    signatures: [{
      label: 'noteToMidi(note)',
      parameters: [{ label: 'note', documentation: 'Note name (e.g., "C4", "A#3")' }],
    }],
  },
  {
    name: 'numeralArgs',
    detail: 'Numeral arguments (internal)',
    documentation: 'Internal function for parsing numeral arguments (Roman numerals, chord numerals) in pattern notation.',
    signatures: [{
      label: 'numeralArgs(args)',
      parameters: [{ label: 'args', documentation: 'Arguments to parse' }],
    }],
  },
  {
    name: 'octaveR',
    detail: 'Octave ratio',
    documentation: 'Xeno-harmonic tuning function. Sets or gets the octave ratio (normally 2:1). Can be changed for non-octave-repeating scales like Bohlen-Pierce (3:1).',
    signatures: [{
      label: 'octaveR(ratio)',
      parameters: [{ label: 'ratio', documentation: 'Frequency ratio for one octave (default: 2)' }],
    }],
  },
  {
    name: 'octaves',
    detail: 'Octave range',
    documentation: 'Sets or constrains the octave range for a pattern. Can be used with voicings or to limit the octave span of notes.',
    signatures: [{
      label: 'octaves(range)',
      parameters: [{ label: 'range', documentation: 'Number of octaves or octave range' }],
    }],
  },
  {
    name: 'octer',
    detail: 'Octave effect',
    documentation: 'Octave effect/harmonizer that adds pitched copies of the sound.',
    signatures: [{
      label: 'octer(amount)',
      parameters: [{ label: 'amount', documentation: 'Effect amount' }],
    }],
  },
  {
    name: 'octersub',
    detail: 'Octave sub effect',
    documentation: 'Sub-octave level for the octer effect.',
    signatures: [{
      label: 'octersub(amount)',
      parameters: [{ label: 'amount', documentation: 'Sub-octave amount' }],
    }],
  },
  {
    name: 'octersubsub',
    detail: 'Octave sub-sub effect',
    documentation: 'Two-octave-down level for the octer effect.',
    signatures: [{
      label: 'octersubsub(amount)',
      parameters: [{ label: 'amount', documentation: 'Sub-sub-octave amount' }],
    }],
  },
  {
    name: 'offset',
    detail: 'Time offset',
    documentation: 'Offsets the pattern in time.',
    signatures: [{
      label: 'offset(cycles)',
      parameters: [{ label: 'cycles', documentation: 'Number of cycles to offset' }],
    }],
  },
  {
    name: 'overgain',
    detail: 'Overdrive gain',
    documentation: 'SuperDirt overdrive effect - controls the gain/drive amount for the overdrive distortion.',
    signatures: [{
      label: 'overgain(amount)',
      parameters: [{ label: 'amount', documentation: 'Drive amount' }],
    }],
  },
  {
    name: 'overshape',
    detail: 'Overdrive shape',
    documentation: 'SuperDirt overdrive effect - controls the waveshaping curve of the overdrive distortion.',
    signatures: [{
      label: 'overshape(amount)',
      parameters: [{ label: 'amount', documentation: 'Shape amount (0-1)' }],
    }],
  },
  {
    name: 'pace',
    detail: 'Set steps per cycle',
    documentation: 'Speeds a pattern up or down to fit the given number of steps per cycle. Experimental stepwise function.',
    signatures: [{
      label: 'pace(stepsPerCycle)',
      parameters: [{ label: 'stepsPerCycle', documentation: 'Number of steps per cycle' }],
    }],
  },
  {
    name: 'pairs',
    detail: 'Create key-value pairs',
    documentation: 'Creates key-value pairs from pattern values. Useful for creating structured data from patterns.',
    signatures: [{
      label: 'pairs(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern to extract pairs from' }],
    }],
  },
  {
    name: 'panorient',
    detail: 'Pan orientation',
    documentation: 'SuperDirt stereo parameter - controls the orientation of the stereo image. Used for multichannel spatialization.',
    signatures: [{
      label: 'panorient(value)',
      parameters: [{ label: 'value', documentation: 'Orientation value' }],
    }],
  },
  {
    name: 'panspan',
    detail: 'Pan span',
    documentation: 'SuperDirt stereo parameter - controls the span/width of the stereo image.',
    signatures: [{
      label: 'panspan(value)',
      parameters: [{ label: 'value', documentation: 'Span value (0-1)' }],
    }],
  },
  {
    name: 'pansplay',
    detail: 'Pan splay',
    documentation: 'SuperDirt stereo parameter - spreads sound across stereo field. Similar to stereo widening.',
    signatures: [{
      label: 'pansplay(value)',
      parameters: [{ label: 'value', documentation: 'Splay amount (0-1)' }],
    }],
  },
  {
    name: 'panwidth',
    detail: 'Pan width',
    documentation: 'SuperDirt stereo parameter - controls the width of the stereo image.',
    signatures: [{
      label: 'panwidth(value)',
      parameters: [{ label: 'value', documentation: 'Width value (0-1)' }],
    }],
  },
  {
    name: 'partials',
    detail: 'Partials control',
    documentation: 'Controls the number of partials/harmonics in synthesis.',
    signatures: [{
      label: 'partials(n)',
      parameters: [{ label: 'n', documentation: 'Number of partials' }],
    }],
  },
  {
    name: 'patt',
    detail: 'Synonym for pattack',
    documentation: 'Pitch envelope attack time in seconds. Synonym for pattack.',
    signatures: [{
      label: 'patt(time)',
      parameters: [{ label: 'time', documentation: 'Attack time in seconds' }],
    }],
  },
  {
    name: 'patternifyAST',
    detail: 'Patternify AST (internal)',
    documentation: 'Internal parser function. Converts an Abstract Syntax Tree into a Strudel pattern. Used by the mini notation parser.',
    signatures: [{
      label: 'patternifyAST(ast)',
      parameters: [{ label: 'ast', documentation: 'Abstract Syntax Tree to convert' }],
    }],
  },
  {
    name: 'pdec',
    detail: 'Synonym for pdecay',
    documentation: 'Pitch envelope decay time in seconds. Synonym for pdecay.',
    signatures: [{
      label: 'pdec(time)',
      parameters: [{ label: 'time', documentation: 'Decay time in seconds' }],
    }],
  },
  {
    name: 'perlinWith',
    detail: 'Perlin with seed',
    documentation: 'Generates Perlin noise with a custom seed function.',
    signatures: [{
      label: 'perlinWith(fn)',
      parameters: [{ label: 'fn', documentation: 'Seed function' }],
    }],
  },
  {
    name: 'phasdp',
    detail: 'Synonym for phaserdepth',
    documentation: 'Phaser effect depth (0-1). Synonym for phaserdepth.',
    signatures: [{
      label: 'phasdp(depth)',
      parameters: [{ label: 'depth', documentation: 'Depth value (0-1)' }],
    }],
  },
  {
    name: 'pick',
    detail: 'Pick patterns by index/name',
    documentation: 'Picks patterns from a list (by index) or lookup table (by name). Maintains structure of original patterns.',
    signatures: [{
      label: 'pick(pat, xs)',
      parameters: [
        { label: 'pat', documentation: 'Pattern of indices or names' },
        { label: 'xs', documentation: 'Array or object of patterns to pick from' }
      ],
    }],
  },
  {
    name: 'pickReset',
    detail: 'Pick with reset',
    documentation: 'Like pick, but resets the chosen pattern when its index is triggered.',
    signatures: [{
      label: 'pickReset(pat, xs)',
      parameters: [
        { label: 'pat', documentation: 'Pattern of indices' },
        { label: 'xs', documentation: 'Array or object of patterns to pick from' }
      ],
    }],
  },
  {
    name: 'pickSqueeze',
    detail: 'Alias for inhabit',
    documentation: 'Alias for inhabit. Picks patterns and squeezes cycles into the target pattern.',
    signatures: [{
      label: 'pickSqueeze(pat, xs)',
      parameters: [
        { label: 'pat', documentation: 'Pattern of indices or names' },
        { label: 'xs', documentation: 'Array or object of patterns to pick from' }
      ],
    }],
  },
  {
    name: 'pickmod',
    detail: 'Pick with wrapping',
    documentation: 'Like pick, but wraps around if index exceeds list size.',
    signatures: [{
      label: 'pickmod(pat, xs)',
      parameters: [
        { label: 'pat', documentation: 'Pattern of indices' },
        { label: 'xs', documentation: 'Array of patterns to pick from' }
      ],
    }],
  },
  {
    name: 'pickmodF',
    detail: 'Pick functions with wrapping',
    documentation: 'Like pickF, but wraps around if index exceeds list size.',
    signatures: [{
      label: 'pickmodF(pat, lookup, fns)',
      parameters: [
        { label: 'pat', documentation: 'Pattern to transform' },
        { label: 'lookup', documentation: 'Pattern of indices' },
        { label: 'fns', documentation: 'Array of functions to pick from' }
      ],
    }],
  },
  {
    name: 'pickmodOut',
    detail: 'Pickmod output (internal)',
    documentation: 'Internal function for the pickmod system. Returns output state from pick modifications.',
    signatures: [{
      label: 'pickmodOut()',
      parameters: [],
    }],
  },
  {
    name: 'pickmodReset',
    detail: 'Pick with wrapping and reset',
    documentation: 'Like pickReset, but wraps around if index exceeds list size.',
    signatures: [{
      label: 'pickmodReset(pat, xs)',
      parameters: [
        { label: 'pat', documentation: 'Pattern of indices' },
        { label: 'xs', documentation: 'Array of patterns to pick from' }
      ],
    }],
  },
  {
    name: 'pickmodRestart',
    detail: 'Pick with wrapping and restart',
    documentation: 'Like pickRestart, but wraps around if index exceeds list size.',
    signatures: [{
      label: 'pickmodRestart(pat, xs)',
      parameters: [
        { label: 'pat', documentation: 'Pattern of indices' },
        { label: 'xs', documentation: 'Array of patterns to pick from' }
      ],
    }],
  },
  {
    name: 'pickmodSqueeze',
    detail: 'Alias for inhabitmod',
    documentation: 'Alias for inhabitmod. Like inhabit with wrapping.',
    signatures: [{
      label: 'pickmodSqueeze(pat, xs)',
      parameters: [
        { label: 'pat', documentation: 'Pattern of indices' },
        { label: 'xs', documentation: 'Array of patterns to pick from' }
      ],
    }],
  },
  {
    name: 'pitchJump',
    detail: 'Pitch jump',
    documentation: 'Jumps the pitch by a specified amount.',
    signatures: [{
      label: 'pitchJump(semitones)',
      parameters: [{ label: 'semitones', documentation: 'Semitones to jump' }],
    }],
  },
  {
    name: 'pitchJumpTime',
    detail: 'Pitch jump time',
    documentation: 'Time at which pitch jump occurs.',
    signatures: [{
      label: 'pitchJumpTime(time)',
      parameters: [{ label: 'time', documentation: 'Time of pitch jump' }],
    }],
  },
  {
    name: 'polyTouch',
    detail: 'Polyphonic aftertouch',
    documentation: 'MIDI polyphonic aftertouch (key pressure).',
    signatures: [{
      label: 'polyTouch(value)',
      parameters: [{ label: 'value', documentation: 'Aftertouch value (0-127)' }],
    }],
  },
  {
    name: 'polyrhythm',
    detail: 'Alias for stack',
    documentation: 'Alias for stack. Plays items at the same time at the same length.',
    signatures: [{
      label: 'polyrhythm(...items)',
      parameters: [],
    }],
  },
  {
    name: 'prel',
    detail: 'Synonym for prelease',
    documentation: 'Pitch envelope release time in seconds. Synonym for prelease.',
    signatures: [{
      label: 'prel(time)',
      parameters: [{ label: 'time', documentation: 'Release time in seconds' }],
    }],
  },
  {
    name: 'psus',
    detail: 'Pitch envelope sustain',
    documentation: 'Pitch envelope sustain level.',
    signatures: [{
      label: 'psus(level)',
      parameters: [{ label: 'level', documentation: 'Sustain level (0-1)' }],
    }],
  },
  {
    name: 'psustain',
    detail: 'Pitch envelope sustain',
    documentation: 'Pitch envelope sustain level.',
    signatures: [{
      label: 'psustain(level)',
      parameters: [{ label: 'level', documentation: 'Sustain level (0-1)' }],
    }],
  },
  {
    name: 'randrun',
    detail: 'Random run',
    documentation: 'Creates a random sequence of numbers.',
    signatures: [{
      label: 'randrun(n)',
      parameters: [{ label: 'n', documentation: 'Length of sequence' }],
    }],
  },
  {
    name: 'rate',
    detail: 'Playback rate',
    documentation: 'Sample playback rate. 1 = normal, 2 = double speed, 0.5 = half speed.',
    signatures: [{
      label: 'rate(speed)',
      parameters: [{ label: 'speed', documentation: 'Playback rate multiplier' }],
    }],
  },
  {
    name: 'rdim',
    detail: 'Synonym for roomdim',
    documentation: 'Reverb lowpass frequency at -60dB in Hz. Synonym for roomdim.',
    signatures: [{
      label: 'rdim(frequency)',
      parameters: [{ label: 'frequency', documentation: 'Frequency in Hz (0-20000)' }],
    }],
  },
  {
    name: 'real',
    detail: 'Real component',
    documentation: 'Extracts or sets the real component of complex numbers. Used for spectral/FFT operations.',
    signatures: [{
      label: 'real(value)',
      parameters: [{ label: 'value', documentation: 'Real component value' }],
    }],
  },
  {
    name: 'repeatTime',
    detail: 'Repeat time',
    documentation: 'Time interval for note repetition.',
    signatures: [{
      label: 'repeatTime(time)',
      parameters: [{ label: 'time', documentation: 'Repeat interval' }],
    }],
  },
  {
    name: 'replicate',
    detail: 'Replicate events',
    documentation: 'Replicates each event a specified number of times.',
    signatures: [{
      label: 'replicate(n)',
      parameters: [{ label: 'n', documentation: 'Number of replications' }],
    }],
  },
  {
    name: 'resonance',
    detail: 'Synonym for lpq',
    documentation: 'Lowpass filter resonance (Q-value). Synonym for lpq.',
    signatures: [{
      label: 'resonance(q)',
      parameters: [{ label: 'q', documentation: 'Resonance factor (0-50)' }],
    }],
  },
  {
    name: 'rfade',
    detail: 'Synonym for roomfade',
    documentation: 'Reverb fade time in seconds. Synonym for roomfade.',
    signatures: [{
      label: 'rfade(seconds)',
      parameters: [{ label: 'seconds', documentation: 'Fade time in seconds' }],
    }],
  },
  {
    name: 'rotate',
    detail: 'Rotate pattern',
    documentation: 'Rotates the pattern by a given number of steps.',
    signatures: [{
      label: 'rotate(n)',
      parameters: [{ label: 'n', documentation: 'Number of steps to rotate' }],
    }],
  },
  {
    name: 'rsize',
    detail: 'Synonym for roomsize',
    documentation: 'Reverb room size (0-10). Synonym for roomsize.',
    signatures: [{
      label: 'rsize(size)',
      parameters: [{ label: 'size', documentation: 'Room size (0-10)' }],
    }],
  },
  {
    name: 'scaleTrans',
    detail: 'Scale transposition',
    documentation: 'Transposes a pattern within a scale by the given number of scale degrees. Notes stay within the scale.',
    signatures: [{
      label: 'scaleTrans(degrees)',
      parameters: [{ label: 'degrees', documentation: 'Number of scale degrees to transpose' }],
    }],
  },
  {
    name: 'scram',
    detail: 'Scramble (alias)',
    documentation: 'Alias for scramble - randomly rearrange pattern segments each cycle.',
    signatures: [{
      label: 'scram(n)',
      parameters: [{ label: 'n', documentation: 'Number of segments to scramble' }],
    }],
  },
  {
    name: 'seconds',
    detail: 'Seconds signal',
    documentation: 'Returns the current time in seconds.',
    signatures: [{
      label: 'seconds',
      parameters: [],
    }],
  },
  {
    name: 'semitone',
    detail: 'Semitone interval ratio',
    documentation: 'Xeno-harmonic tuning function. Sets or gets the semitone interval ratio for microtonal tuning systems. In standard 12-TET, this is 2^(1/12).',
    signatures: [{
      label: 'semitone(ratio)',
      parameters: [{ label: 'ratio', documentation: 'Frequency ratio for one semitone' }],
    }],
  },
  {
    name: 'seqPLoop',
    detail: 'Sequence pattern loop',
    documentation: 'Creates a looping sequence of patterns. Similar to seq but with loop behavior control.',
    signatures: [{
      label: 'seqPLoop(...patterns)',
      parameters: [],
    }],
  },
  {
    name: 'sequence',
    detail: 'Alias for seq',
    documentation: 'Alias for seq/fastcat. Crams items into one cycle.',
    signatures: [{
      label: 'sequence(...items)',
      parameters: [],
    }],
  },
  {
    name: 'sequenceP',
    detail: 'Sequence pattern (internal)',
    documentation: 'Internal pattern sequencing function. Creates a sequence from pattern objects.',
    signatures: [{
      label: 'sequenceP(...patterns)',
      parameters: [],
    }],
  },
  {
    name: 'shrink',
    detail: 'Shrink pattern progressively',
    documentation: 'Progressively shrinks the pattern by n steps until nothing left. Positive shrinks from start, negative from end. Experimental.',
    signatures: [{
      label: 'shrink(n)',
      parameters: [{ label: 'n', documentation: 'Number of steps to shrink by each cycle' }],
    }],
  },
  {
    name: 'shrinklist',
    detail: 'Shrink list (internal)',
    documentation: 'Internal stepwise function. Shrinks a list of patterns. Used by other stepwise pattern functions.',
    signatures: [{
      label: 'shrinklist(patterns)',
      parameters: [{ label: 'patterns', documentation: 'List of patterns to shrink' }],
    }],
  },
  {
    name: 'signal',
    detail: 'Create continuous signal',
    documentation: 'Creates a continuous signal pattern from a function of time.',
    signatures: [{
      label: 'signal(fn)',
      parameters: [{ label: 'fn', documentation: 'Function of time returning value' }],
    }],
  },
  {
    name: 'slide',
    detail: 'Pitch slide',
    documentation: 'Slides pitch between notes (portamento).',
    signatures: [{
      label: 'slide(amount)',
      parameters: [{ label: 'amount', documentation: 'Slide amount' }],
    }],
  },
  {
    name: 'slowChunk',
    detail: 'Slow chunk',
    documentation: 'Divides pattern into n parts, cycles through applying function to each part (one per cycle).',
    signatures: [{
      label: 'slowChunk(n, fn)',
      parameters: [
        { label: 'n', documentation: 'Number of parts' },
        { label: 'fn', documentation: 'Function to apply' }
      ],
    }],
  },
  {
    name: 'slowcatPrime',
    detail: 'Slowcat prime (internal)',
    documentation: 'Internal variant of slowcat. Concatenates patterns one per cycle with prime number cycling behavior.',
    signatures: [{
      label: 'slowcatPrime(...patterns)',
      parameters: [],
    }],
  },
  {
    name: 'slowchunk',
    detail: 'Alias for slowChunk',
    documentation: 'Alias for slowChunk/chunk. Divides pattern into n parts, applies function to each.',
    signatures: [{
      label: 'slowchunk(n, fn)',
      parameters: [
        { label: 'n', documentation: 'Number of parts' },
        { label: 'fn', documentation: 'Function to apply' }
      ],
    }],
  },
  {
    name: 'smear',
    detail: 'Spectral smear',
    documentation: 'SuperDirt spectral effect - smears/blurs the frequency content of the audio over time.',
    signatures: [{
      label: 'smear(amount)',
      parameters: [{ label: 'amount', documentation: 'Smear amount' }],
    }],
  },
  {
    name: 'sol2note',
    detail: 'Solfege to note',
    documentation: 'Convert solfege notation (do, re, mi, etc.) to note numbers.',
    signatures: [{
      label: 'sol2note(solfege)',
      parameters: [{ label: 'solfege', documentation: 'Solfege syllable (do, re, mi, fa, sol, la, si/ti)' }],
    }],
  },
  {
    name: 'songPtr',
    detail: 'Song pointer (internal)',
    documentation: 'Internal function for managing song position/playhead.',
    signatures: [{
      label: 'songPtr()',
      parameters: [],
    }],
  },
  {
    name: 'sparsity',
    detail: 'Alias for slow',
    documentation: 'Alias for slow. Slows down a pattern over the given number of cycles.',
    signatures: [{
      label: 'sparsity(factor)',
      parameters: [{ label: 'factor', documentation: 'Slow down factor' }],
    }],
  },
  {
    name: 'speak',
    detail: 'Speech synthesis',
    documentation: 'Uses speech synthesis to speak the pattern values.',
    signatures: [{
      label: 'speak(text)',
      parameters: [{ label: 'text', documentation: 'Text to speak' }],
    }],
  },
  {
    name: 'splice',
    detail: 'Splice sample',
    documentation: 'Cuts a sample into slices and plays them according to the pattern.',
    signatures: [{
      label: 'splice(n, pat)',
      parameters: [
        { label: 'n', documentation: 'Number of slices' },
        { label: 'pat', documentation: 'Pattern of slice indices' }
      ],
    }],
  },
  {
    name: 'splitAt',
    detail: 'Split pattern at position',
    documentation: 'Splits a pattern at a given position, returning two patterns: one before and one after the split point.',
    signatures: [{
      label: 'splitAt(position)',
      parameters: [{ label: 'position', documentation: 'Position to split at (0-1 within cycle)' }],
    }],
  },
  {
    name: 'squeeze',
    detail: 'Squeeze patterns by index',
    documentation: 'Picks from a list of values/patterns via index. Selected pattern is compressed to fit the selecting event duration.',
    signatures: [{
      label: 'squeeze(pat, xs)',
      parameters: [
        { label: 'pat', documentation: 'Pattern of indices' },
        { label: 'xs', documentation: 'Array of patterns to pick from' }
      ],
    }],
  },
  {
    name: 'stackBy',
    detail: 'Stack with function',
    documentation: 'Stack patterns together, applying a function to combine them.',
    signatures: [{
      label: 'stackBy(fn, patterns)',
      parameters: [
        { label: 'fn', documentation: 'Function to apply when stacking' },
        { label: 'patterns', documentation: 'Patterns to stack' },
      ],
    }],
  },
  {
    name: 'stackCentre',
    detail: 'Stack centered',
    documentation: 'Stack patterns with center alignment.',
    signatures: [{
      label: 'stackCentre(...patterns)',
      parameters: [{ label: 'patterns', documentation: 'Patterns to stack (center-aligned)' }],
    }],
  },
  {
    name: 'stackLeft',
    detail: 'Stack left-aligned',
    documentation: 'Stack patterns with left alignment.',
    signatures: [{
      label: 'stackLeft(...patterns)',
      parameters: [{ label: 'patterns', documentation: 'Patterns to stack (left-aligned)' }],
    }],
  },
  {
    name: 'stackRight',
    detail: 'Stack right-aligned',
    documentation: 'Stack patterns with right alignment.',
    signatures: [{
      label: 'stackRight(...patterns)',
      parameters: [{ label: 'patterns', documentation: 'Patterns to stack (right-aligned)' }],
    }],
  },
  {
    name: 'steady',
    detail: 'Steady pattern',
    documentation: 'Creates a steady/constant pattern that doesn\'t change over time.',
    signatures: [{
      label: 'steady(value)',
      parameters: [{ label: 'value', documentation: 'Constant value for the pattern' }],
    }],
  },
  {
    name: 'stepalt',
    detail: 'Stepwise alternate',
    documentation: 'Concatenates patterns stepwise. If an argument is a list, alternates between elements. Experimental.',
    signatures: [{
      label: 'stepalt(...pats)',
      parameters: [],
    }],
  },
  {
    name: 'steps',
    detail: 'Alias for pace',
    documentation: 'Alias for pace. Sets the number of steps per cycle. Experimental.',
    signatures: [{
      label: 'steps(n)',
      parameters: [{ label: 'n', documentation: 'Steps per cycle' }],
    }],
  },
  {
    name: 'stepsPerOctave',
    detail: 'Microtonal steps per octave',
    documentation: 'Xeno-harmonic tuning function. Sets the number of equal divisions of the octave for microtonal tuning. Standard is 12-TET (12 steps). Use for scales like 19-TET, 31-TET, etc.',
    signatures: [{
      label: 'stepsPerOctave(steps)',
      parameters: [{ label: 'steps', documentation: 'Number of equal steps per octave (e.g., 12, 19, 31)' }],
    }],
  },
  {
    name: 'strans',
    detail: 'Scale transpose',
    documentation: 'Transposes notes by scale degrees within the current scale. Like mtranspose but may use different internals.',
    signatures: [{
      label: 'strans(degrees)',
      parameters: [{ label: 'degrees', documentation: 'Number of scale degrees to transpose' }],
    }],
  },
  {
    name: 'stringifyValues',
    detail: 'Stringify pattern values (internal)',
    documentation: 'Internal utility function. Converts pattern values to their string representations. Used for debugging and display.',
    signatures: [{
      label: 'stringifyValues(pattern)',
      parameters: [{ label: 'pattern', documentation: 'Pattern whose values to stringify' }],
    }],
  },
  {
    name: 'stutWith',
    detail: 'Echo with function',
    documentation: 'Superimpose and offset multiple times, applying a function each iteration. Alias: echoWith.',
    signatures: [{
      label: 'stutWith(times, time, fn)',
      parameters: [
        { label: 'times', documentation: 'Number of repetitions' },
        { label: 'time', documentation: 'Cycle offset between iterations' },
        { label: 'fn', documentation: 'Function to apply (receives pattern and index)' }
      ],
    }],
  },
  {
    name: 'stutwith',
    detail: 'Echo with function',
    documentation: 'Alias for stutWith/echoWith. Superimpose and offset with function applied each iteration.',
    signatures: [{
      label: 'stutwith(times, time, fn)',
      parameters: [
        { label: 'times', documentation: 'Number of repetitions' },
        { label: 'time', documentation: 'Cycle offset between iterations' },
        { label: 'fn', documentation: 'Function to apply' }
      ],
    }],
  },
  {
    name: 'sustainpedal',
    detail: 'Sustain pedal',
    documentation: 'MIDI sustain pedal control.',
    signatures: [{
      label: 'sustainpedal(value)',
      parameters: [{ label: 'value', documentation: 'Pedal value (0-127)' }],
    }],
  },
  {
    name: 'take',
    detail: 'Take steps',
    documentation: 'Takes the given number of steps from a pattern. Positive takes from start, negative from end. Experimental stepwise function.',
    signatures: [{
      label: 'take(n)',
      parameters: [{ label: 'n', documentation: 'Number of steps to take (positive=start, negative=end)' }],
    }],
  },
  {
    name: 'timeCat',
    detail: 'Alias for stepcat',
    documentation: 'Alias for stepcat. Concatenates patterns proportionally to step count.',
    signatures: [{
      label: 'timeCat(...pats)',
      parameters: [],
    }],
  },
  {
    name: 'timecat',
    detail: 'Alias for stepcat',
    documentation: 'Alias for stepcat. Concatenates patterns proportionally to step count.',
    signatures: [{
      label: 'timecat(...pats)',
      parameters: [],
    }],
  },
  {
    name: 'toBipolar',
    detail: 'Convert to bipolar',
    documentation: 'Converts a unipolar value (0 to 1) to bipolar (-1 to 1).',
    signatures: [{
      label: 'toBipolar(value)',
      parameters: [{ label: 'value', documentation: 'Unipolar value (0 to 1)' }],
    }],
  },
  {
    name: 'tokenizeNote',
    detail: 'Tokenize note string (internal)',
    documentation: 'Internal parser function. Tokenizes a note string into its components (note name, octave, accidentals). Used for note parsing.',
    signatures: [{
      label: 'tokenizeNote(noteString)',
      parameters: [{ label: 'noteString', documentation: 'Note string to tokenize (e.g., "C#4")' }],
    }],
  },
  {
    name: 'tour',
    detail: 'Tour through patterns',
    documentation: 'Inserts a pattern into a list, moving backwards through the list on successive repetitions. Experimental stepwise function.',
    signatures: [{
      label: 'tour(pat, ...pats)',
      parameters: [],
    }],
  },
  {
    name: 'trans',
    detail: 'Transpose',
    documentation: 'Transposes notes by semitones. Similar to add but specifically for note transposition.',
    signatures: [{
      label: 'trans(semitones)',
      parameters: [{ label: 'semitones', documentation: 'Number of semitones to transpose' }],
    }],
  },
  {
    name: 'triode',
    detail: 'Triode distortion',
    documentation: 'Triode tube distortion effect.',
    signatures: [{
      label: 'triode(amount)',
      parameters: [{ label: 'amount', documentation: 'Distortion amount' }],
    }],
  },
  {
    name: 'tsdelay',
    detail: 'Time-stretch delay',
    documentation: 'SuperDirt delay parameter - controls time-stretch delay send level.',
    signatures: [{
      label: 'tsdelay(amount)',
      parameters: [{ label: 'amount', documentation: 'Delay send amount (0-1)' }],
    }],
  },
  {
    name: 'unicodeToBase64',
    detail: 'Encode unicode to base64 (internal)',
    documentation: 'Internal utility function. Encodes unicode text to a base64 string. Used for code sharing/compression.',
    signatures: [{
      label: 'unicodeToBase64(text)',
      parameters: [{ label: 'text', documentation: 'Unicode text to encode' }],
    }],
  },
  {
    name: 'uniq',
    detail: 'Remove duplicates',
    documentation: 'Removes duplicate consecutive values from the pattern, keeping only unique adjacent events.',
    signatures: [{
      label: 'uniq()',
      parameters: [],
    }],
  },
  {
    name: 'uniqsort',
    detail: 'Unique sorted values',
    documentation: 'Returns unique values from the pattern, sorted in ascending order.',
    signatures: [{
      label: 'uniqsort()',
      parameters: [],
    }],
  },
  {
    name: 'uniqsortr',
    detail: 'Unique reverse sorted',
    documentation: 'Returns unique values from the pattern, sorted in descending (reverse) order.',
    signatures: [{
      label: 'uniqsortr()',
      parameters: [],
    }],
  },
  {
    name: 'valueToMidi',
    detail: 'Value to MIDI number',
    documentation: 'Converts a note value (note name or number) to its MIDI note number representation.',
    signatures: [{
      label: 'valueToMidi(value)',
      parameters: [{ label: 'value', documentation: 'Note value to convert' }],
    }],
  },
  {
    name: 'vmod',
    detail: 'Vibrato depth (synonym for vibmod)',
    documentation: 'Sets the vibrato depth in semitones. Synonym for `vibmod`. Only has an effect if `vibrato`, `vib`, or `v` is also set.\n\nExample:\n```js\nnote("a e").vib(4).vmod("<.25 .5 1 2 12>")\n```',
    signatures: [{
      label: 'vmod(depth)',
      parameters: [{ label: 'depth', documentation: 'Vibrato depth in semitones' }],
    }],
  },
  {
    name: 'voice',
    detail: 'Voice control',
    documentation: 'Selects a voice or algorithm for FM synth.',
    signatures: [{
      label: 'voice(n)',
      parameters: [{ label: 'n', documentation: 'Voice number or name' }],
    }],
  },
  {
    name: 'voicingAlias',
    detail: 'Define voicing alias',
    documentation: 'Creates an alias for a voicing. Allows you to define custom names for chord voicings.',
    signatures: [{
      label: 'voicingAlias(alias, voicing)',
      parameters: [
        { label: 'alias', documentation: 'Name for the alias' },
        { label: 'voicing', documentation: 'Voicing to alias' },
      ],
    }],
  },
  {
    name: 'warpatt',
    detail: 'Warp attack (alias)',
    documentation: 'Alias for warpattack - attack time of the wavetable oscillator\'s warp envelope',
    signatures: [{
      label: 'warpatt(time)',
      parameters: [{ label: 'time', documentation: 'Attack time in seconds' }],
    }],
  },
  {
    name: 'warpdec',
    detail: 'Warp decay (alias)',
    documentation: 'Alias for warpdecay - decay time of the wavetable oscillator\'s warp envelope',
    signatures: [{
      label: 'warpdec(time)',
      parameters: [{ label: 'time', documentation: 'Decay time in seconds' }],
    }],
  },
  {
    name: 'warprel',
    detail: 'Warp release (alias)',
    documentation: 'Alias for warprelease - release time of the wavetable oscillator\'s warp envelope',
    signatures: [{
      label: 'warprel(time)',
      parameters: [{ label: 'time', documentation: 'Release time in seconds' }],
    }],
  },
  {
    name: 'warpsus',
    detail: 'Warp sustain (alias)',
    documentation: 'Alias for warpsustain - sustain level of the wavetable oscillator\'s warp envelope',
    signatures: [{
      label: 'warpsus(level)',
      parameters: [{ label: 'level', documentation: 'Sustain level (0 to 1)' }],
    }],
  },
  {
    name: 'wavetablePhaseRand',
    detail: 'Wavetable phase randomization',
    documentation: 'Phase randomization for wavetable synthesis.',
    signatures: [{
      label: 'wavetablePhaseRand(amount)',
      parameters: [{ label: 'amount', documentation: 'Phase randomization amount' }],
    }],
  },
  {
    name: 'wavetablePosition',
    detail: 'Wavetable position',
    documentation: 'Position within the wavetable (0-1).',
    signatures: [{
      label: 'wavetablePosition(pos)',
      parameters: [{ label: 'pos', documentation: 'Position in wavetable (0-1)' }],
    }],
  },
  {
    name: 'wavetableWarp',
    detail: 'Wavetable warp',
    documentation: 'Warp/morph amount for wavetable.',
    signatures: [{
      label: 'wavetableWarp(amount)',
      parameters: [{ label: 'amount', documentation: 'Warp amount' }],
    }],
  },
  {
    name: 'wavetableWarpMode',
    detail: 'Wavetable warp mode',
    documentation: 'Warp mode for wavetable synthesis.',
    signatures: [{
      label: 'wavetableWarpMode(mode)',
      parameters: [{ label: 'mode', documentation: 'Warp mode' }],
    }],
  },
  {
    name: 'wchooseCycles',
    detail: 'Weighted choose per cycle',
    documentation: 'Picks one element at random each cycle with probability weights. Alias: wrandcat.',
    signatures: [{
      label: 'wchooseCycles(...pairs)',
      parameters: [],
    }],
  },
  {
    name: 'withValue',
    detail: 'Transform value',
    documentation: 'Applies a function to each value in the pattern. Like fmap but for the value portion of events.',
    signatures: [{
      label: 'withValue(fn)',
      parameters: [{ label: 'fn', documentation: 'Function to apply to each value' }],
    }],
  },
  {
    name: 'wrandcat',
    detail: 'Alias for wchooseCycles',
    documentation: 'Alias for wchooseCycles. Picks one element at random each cycle with probability weights.',
    signatures: [{
      label: 'wrandcat(...pairs)',
      parameters: [],
    }],
  },
  {
    name: 'wtatt',
    detail: 'Wavetable attack (alias)',
    documentation: 'Alias for wtattack - attack time of the wavetable oscillator\'s position envelope',
    signatures: [{
      label: 'wtatt(time)',
      parameters: [{ label: 'time', documentation: 'Attack time in seconds' }],
    }],
  },
  {
    name: 'wtdec',
    detail: 'Wavetable decay (alias)',
    documentation: 'Alias for wtdecay - decay time of the wavetable oscillator\'s position envelope',
    signatures: [{
      label: 'wtdec(time)',
      parameters: [{ label: 'time', documentation: 'Decay time in seconds' }],
    }],
  },
  {
    name: 'wtrel',
    detail: 'Wavetable release (alias)',
    documentation: 'Alias for wtrelease - release time of the wavetable oscillator\'s position envelope',
    signatures: [{
      label: 'wtrel(time)',
      parameters: [{ label: 'time', documentation: 'Release time in seconds' }],
    }],
  },
  {
    name: 'wtsus',
    detail: 'Wavetable sustain (alias)',
    documentation: 'Alias for wtsustain - sustain level of the wavetable oscillator\'s position envelope',
    signatures: [{
      label: 'wtsus(level)',
      parameters: [{ label: 'level', documentation: 'Sustain level (0 to 1)' }],
    }],
  },
  {
    name: 'xsdelay',
    detail: 'Cross-fading delay',
    documentation: 'SuperDirt delay parameter - cross-fading delay send level',
    signatures: [{
      label: 'xsdelay(amount)',
      parameters: [{ label: 'amount', documentation: 'Delay send amount (0-1)' }],
    }],
  },
  {
    name: 'zcrush',
    detail: 'ZZFX crush',
    documentation: 'ZZFX bit-crusher effect.',
    signatures: [{
      label: 'zcrush(amount)',
      parameters: [{ label: 'amount', documentation: 'Crush amount' }],
    }],
  },
  {
    name: 'zdelay',
    detail: 'ZZFX delay',
    documentation: 'ZZFX delay effect.',
    signatures: [{
      label: 'zdelay(time)',
      parameters: [{ label: 'time', documentation: 'Delay time' }],
    }],
  },
  {
    name: 'zipWith',
    detail: 'Zip with function',
    documentation: 'Zips patterns together applying a combining function to each pair of values.',
    signatures: [{
      label: 'zipWith(fn, ...pats)',
      parameters: [{ label: 'fn', documentation: 'Function to combine values' }],
    }],
  },
  {
    name: 'zmod',
    detail: 'ZZFX modulation',
    documentation: 'ZZFX modulation effect.',
    signatures: [{
      label: 'zmod(amount)',
      parameters: [{ label: 'amount', documentation: 'Modulation amount' }],
    }],
  },
  {
    name: 'znoise',
    detail: 'ZZFX noise',
    documentation: 'ZZFX noise effect.',
    signatures: [{
      label: 'znoise(amount)',
      parameters: [{ label: 'amount', documentation: 'Noise amount' }],
    }],
  },
  {
    name: 'zoomArc',
    detail: 'Zoom into time arc',
    documentation: 'Zooms into a specific time arc/span within the pattern. Used for focusing on a portion of the pattern cycle.',
    signatures: [{
      label: 'zoomArc(begin, end)',
      parameters: [
        { label: 'begin', documentation: 'Start of the arc (0-1)' },
        { label: 'end', documentation: 'End of the arc (0-1)' },
      ],
    }],
  },
  {
    name: 'zoomarc',
    detail: 'Zoom into time arc',
    documentation: 'Alias for zoomArc. Zooms into a specific time arc/span within the pattern.',
    signatures: [{
      label: 'zoomarc(begin, end)',
      parameters: [
        { label: 'begin', documentation: 'Start of the arc (0-1)' },
        { label: 'end', documentation: 'End of the arc (0-1)' },
      ],
    }],
  },
  {
    name: 'zrand',
    detail: 'ZZFX randomness',
    documentation: 'ZZFX randomness effect.',
    signatures: [{
      label: 'zrand(amount)',
      parameters: [{ label: 'amount', documentation: 'Randomness amount' }],
    }],
  },
  {
    name: 'zzfx',
    detail: 'ZZFX synthesizer',
    documentation: 'ZZFX tiny sound synthesizer. Takes ZZFX parameter array.',
    signatures: [{
      label: 'zzfx(...params)',
      parameters: [],
    }],
  },
  // === MISSING FUNCTIONS FROM STRUDEL DOCS ===
  // Tremolo aliases
  {
    name: 'tremsync',
    detail: 'Tremolo sync (alias)',
    documentation: 'Alias for tremolosync - sync tremolo to cycles',
    signatures: [{
      label: 'tremsync(cycles)',
      parameters: [{ label: 'cycles', documentation: 'Cycles to sync tremolo to' }],
    }],
  },
  {
    name: 'tremdepth',
    detail: 'Tremolo depth (alias)',
    documentation: 'Alias for tremolodepth - tremolo modulation depth',
    signatures: [{
      label: 'tremdepth(amount)',
      parameters: [{ label: 'amount', documentation: 'Depth of tremolo (0-1)' }],
    }],
  },
  {
    name: 'tremskew',
    detail: 'Tremolo skew (alias)',
    documentation: 'Alias for tremoloskew - skew the tremolo waveform',
    signatures: [{
      label: 'tremskew(amount)',
      parameters: [{ label: 'amount', documentation: 'Skew amount' }],
    }],
  },
  {
    name: 'tremphase',
    detail: 'Tremolo phase (alias)',
    documentation: 'Alias for tremolophase - phase of the tremolo LFO',
    signatures: [{
      label: 'tremphase(phase)',
      parameters: [{ label: 'phase', documentation: 'Phase offset (0-1)' }],
    }],
  },
  {
    name: 'tremshape',
    detail: 'Tremolo shape (alias)',
    documentation: 'Alias for tremoloshape - shape of the tremolo waveform',
    signatures: [{
      label: 'tremshape(shape)',
      parameters: [{ label: 'shape', documentation: 'Shape number (0, 1, 2, ...)' }],
    }],
  },
  // Postgain alias
  {
    name: 'post',
    detail: 'Post gain (alias)',
    documentation: 'Alias for postgain - gain applied after effects',
    signatures: [{
      label: 'post(amount)',
      parameters: [{ label: 'amount', documentation: 'Post-effects gain level' }],
    }],
  },
  // MIDI input alias
  {
    name: 'midin',
    detail: 'MIDI input (alias)',
    documentation: 'Alias for midiin - receive MIDI input',
    signatures: [{
      label: 'midin()',
      parameters: [],
    }],
  },
  // Mouse Y signal
  {
    name: 'mousey',
    detail: 'Mouse Y position (alias)',
    documentation: 'Alias for mouseY - continuous signal of mouse Y position (0-1)',
    signatures: [{
      label: 'mousey',
      documentation: 'Use with .range() to set output range',
      parameters: [],
    }],
  },
  // Tempo setting functions
  {
    name: 'setbpm',
    detail: 'Set BPM (alias)',
    documentation: 'Alias for setBpm - set tempo in beats per minute',
    signatures: [{
      label: 'setbpm(bpm)',
      parameters: [{ label: 'bpm', documentation: 'Beats per minute' }],
    }],
  },
  {
    name: 'setBpm',
    detail: 'Set BPM',
    documentation: 'Set the tempo in beats per minute',
    signatures: [{
      label: 'setBpm(bpm)',
      parameters: [{ label: 'bpm', documentation: 'Beats per minute (e.g., 120)' }],
    }],
  },
  {
    name: 'setcpm',
    detail: 'Set CPM',
    documentation: 'Set the tempo in cycles per minute',
    signatures: [{
      label: 'setcpm(cpm)',
      parameters: [{ label: 'cpm', documentation: 'Cycles per minute' }],
    }],
  },
  // Bipolar signal variants (-1 to 1)
  {
    name: 'sine2',
    detail: 'Sine signal (bipolar)',
    documentation: 'Continuous sine wave from -1 to 1',
    signatures: [{
      label: 'sine2',
      documentation: 'Use with .range() to set output range',
      parameters: [],
    }],
  },
  {
    name: 'saw2',
    detail: 'Sawtooth signal (bipolar)',
    documentation: 'Continuous sawtooth wave from -1 to 1',
    signatures: [{
      label: 'saw2',
      documentation: 'Use with .range() to set output range',
      parameters: [],
    }],
  },
  {
    name: 'tri2',
    detail: 'Triangle signal (bipolar)',
    documentation: 'Continuous triangle wave from -1 to 1',
    signatures: [{
      label: 'tri2',
      documentation: 'Use with .range() to set output range',
      parameters: [],
    }],
  },
  {
    name: 'square2',
    detail: 'Square signal (bipolar)',
    documentation: 'Continuous square wave alternating between -1 and 1',
    signatures: [{
      label: 'square2',
      documentation: 'Use with .range() to set output range',
      parameters: [],
    }],
  },
  {
    name: 'cosine2',
    detail: 'Cosine signal (bipolar)',
    documentation: 'Continuous cosine wave from -1 to 1',
    signatures: [{
      label: 'cosine2',
      documentation: 'Use with .range() to set output range',
      parameters: [],
    }],
  },
  {
    name: 'rand2',
    detail: 'Random signal (bipolar)',
    documentation: 'Continuous random values from -1 to 1',
    signatures: [{
      label: 'rand2',
      documentation: 'Use with .range() to set output range',
      parameters: [],
    }],
  },
  // Duck attack alias
  {
    name: 'duckatt',
    detail: 'Duck attack (alias)',
    documentation: 'Alias for duckattack - attack time for ducking/sidechain',
    signatures: [{
      label: 'duckatt(time)',
      parameters: [{ label: 'time', documentation: 'Attack time in seconds' }],
    }],
  },
  // Visualization functions
  {
    name: 'pianoroll',
    detail: 'Piano roll visualization',
    documentation: 'Display a scrolling piano roll visualization',
    signatures: [{
      label: 'pianoroll()',
      parameters: [],
    }],
  },
  {
    name: 'punchcard',
    detail: 'Punchcard visualization',
    documentation: 'Display a punchcard-style visualization',
    signatures: [{
      label: 'punchcard()',
      parameters: [],
    }],
  },
  {
    name: '_pianoroll',
    detail: 'Inline piano roll',
    documentation: 'Display an inline piano roll visualization',
    signatures: [{
      label: '_pianoroll()',
      parameters: [],
    }],
  },
  {
    name: '_punchcard',
    detail: 'Inline punchcard',
    documentation: 'Display an inline punchcard visualization',
    signatures: [{
      label: '_punchcard()',
      parameters: [],
    }],
  },
  {
    name: 'spiral',
    detail: 'Spiral visualization',
    documentation: 'Display a spiral visualization',
    signatures: [{
      label: 'spiral()',
      parameters: [],
    }],
  },
  {
    name: '_spiral',
    detail: 'Inline spiral',
    documentation: 'Display an inline spiral visualization',
    signatures: [{
      label: '_spiral()',
      parameters: [],
    }],
  },
  {
    name: 'scope',
    detail: 'Oscilloscope',
    documentation: 'Display an oscilloscope visualization',
    signatures: [{
      label: 'scope()',
      parameters: [],
    }],
  },
  {
    name: 'tscope',
    detail: 'Triggered oscilloscope',
    documentation: 'Alias for scope - triggered oscilloscope visualization',
    signatures: [{
      label: 'tscope()',
      parameters: [],
    }],
  },
  {
    name: '_scope',
    detail: 'Inline oscilloscope',
    documentation: 'Display an inline oscilloscope visualization',
    signatures: [{
      label: '_scope()',
      parameters: [],
    }],
  },
  {
    name: 'pitchwheel',
    detail: 'Pitch wheel visualization',
    documentation: 'Display a pitch circle visualization',
    signatures: [{
      label: 'pitchwheel()',
      parameters: [],
    }],
  },
  {
    name: '_pitchwheel',
    detail: 'Inline pitch wheel',
    documentation: 'Display an inline pitch circle visualization',
    signatures: [{
      label: '_pitchwheel()',
      parameters: [],
    }],
  },
  {
    name: 'spectrum',
    detail: 'Spectrum analyzer',
    documentation: 'Display a spectrum analyzer visualization',
    signatures: [{
      label: 'spectrum()',
      parameters: [],
    }],
  },
  {
    name: '_spectrum',
    detail: 'Inline spectrum analyzer',
    documentation: 'Display an inline spectrum analyzer visualization',
    signatures: [{
      label: '_spectrum()',
      parameters: [],
    }],
  },
  // Noise types
  {
    name: 'crackle',
    detail: 'Crackle noise',
    documentation: 'Crackle noise oscillator',
    signatures: [{
      label: 'crackle',
      documentation: 'Use .density() to control crackle rate',
      parameters: [],
    }],
  },
  // Sample loading
  {
    name: 'samples',
    detail: 'Load samples',
    documentation: 'Load custom sample maps from URLs or objects',
    signatures: [{
      label: 'samples(sampleMap)',
      parameters: [{ label: 'sampleMap', documentation: 'Object mapping sample names to URLs, or URL to sample pack' }],
    }, {
      label: 'samples(url, prefix)',
      parameters: [
        { label: 'url', documentation: 'URL to sample pack or GitHub repo' },
        { label: 'prefix', documentation: 'Optional prefix for sample names' },
      ],
    }],
  },
  {
    name: 'soundAlias',
    detail: 'Create sound alias',
    documentation: 'Create an alias for a sound/sample name',
    signatures: [{
      label: 'soundAlias(aliases)',
      parameters: [{ label: 'aliases', documentation: 'Object mapping alias names to sound names' }],
    }],
  },
  // Register function
  {
    name: 'register',
    detail: 'Register custom function',
    documentation: 'Register a custom function to be available as a pattern method',
    signatures: [{
      label: 'register(name, function)',
      parameters: [
        { label: 'name', documentation: 'Name of the function to register' },
        { label: 'function', documentation: 'Function implementation' },
      ],
    }],
  },
  // OSC output
  {
    name: 'osc',
    detail: 'OSC output',
    documentation: 'Send pattern events via OSC (Open Sound Control)',
    signatures: [{
      label: 'osc()',
      parameters: [],
    }],
  },
  // MQTT output
  {
    name: 'mqtt',
    detail: 'MQTT output',
    documentation: 'Send pattern events via MQTT',
    signatures: [{
      label: 'mqtt(topic)',
      parameters: [{ label: 'topic', documentation: 'MQTT topic to publish to' }],
    }],
  },
  // MIDI maps
  {
    name: 'midimaps',
    detail: 'Define MIDI mappings',
    documentation: 'Define custom MIDI CC mappings',
    signatures: [{
      label: 'midimaps(mappings)',
      parameters: [{ label: 'mappings', documentation: 'Object mapping control names to CC numbers' }],
    }],
  },
  {
    name: 'defaultmidimap',
    detail: 'Default MIDI map',
    documentation: 'Use the default MIDI mapping',
    signatures: [{
      label: 'defaultmidimap()',
      parameters: [],
    }],
  },
  // CSS styling
  {
    name: 'markcss',
    detail: 'CSS for highlighting',
    documentation: 'Set CSS styles for event highlighting/visualization',
    signatures: [{
      label: 'markcss(css)',
      parameters: [{ label: 'css', documentation: 'CSS string for styling highlighted elements' }],
    }],
  },
  // Amplitude modulation
  {
    name: 'am',
    detail: 'Amplitude modulation',
    documentation: 'Apply amplitude modulation',
    signatures: [{
      label: 'am(frequency)',
      parameters: [{ label: 'frequency', documentation: 'Modulation frequency in Hz' }],
    }],
  },
  // Euclidean legato
  {
    name: 'euclidLegato',
    detail: 'Euclidean legato',
    documentation: 'Euclidean rhythm with legato (connected notes)',
    signatures: [{
      label: 'euclidLegato(pulses, steps)',
      parameters: [
        { label: 'pulses', documentation: 'Number of pulses/hits' },
        { label: 'steps', documentation: 'Total number of steps' },
      ],
    }, {
      label: 'euclidLegato(pulses, steps, rotation)',
      parameters: [
        { label: 'pulses', documentation: 'Number of pulses/hits' },
        { label: 'steps', documentation: 'Total number of steps' },
        { label: 'rotation', documentation: 'Rotation offset' },
      ],
    }],
  },
  // MIDI output
  {
    name: 'midi',
    detail: 'MIDI output',
    documentation: 'Send pattern events to MIDI output',
    signatures: [{
      label: 'midi()',
      parameters: [],
    }, {
      label: 'midi(output)',
      parameters: [{ label: 'output', documentation: 'MIDI output device name' }],
    }],
  },

];

// Common typos and their corrections
const TYPO_CORRECTIONS: Record<string, string> = {
  // Sample typos
  'db': 'bd',
  'ds': 'sd',
  'kick': 'bd',
  'snare': 'sd',
  'hihat': 'hh',
  'openhat': 'oh',
  'clap': 'cp',
  'cowbell': 'cb',
  'crash': 'cr',
  'ride': 'rd',
  // Note typos
  'cf': 'c',
  'ef': 'e',
  'bf': 'b',
  // Function typos
  'sounds': 'sound',
  'notes': 'note',
  'filters': 'lpf',
  'lowpass': 'lpf',
  'highpass': 'hpf',
  'bandpass': 'bpf',
  'reverb': 'room',
  'echo': 'delay',
  'volume': 'gain',
  'reverse': 'rev',
};

/**
 * Get all available samples (dynamic + defaults merged)
 * Always includes default samples as a baseline, adds dynamic samples on top
 */
function getAllSamples(): string[] {
  if (dynamicSamples.length > 0) {
    // Merge defaults with dynamic, removing duplicates
    const combined = new Set([...DEFAULT_SAMPLE_NAMES, ...dynamicSamples]);
    return Array.from(combined);
  }
  return DEFAULT_SAMPLE_NAMES;
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  
  return matrix[b.length][a.length];
}

/**
 * Find similar words for typo suggestions
 */
function findSimilar(word: string, candidates: string[], maxDistance = 2): string[] {
  const lowerWord = word.toLowerCase();
  
  // Check explicit typo corrections first
  if (TYPO_CORRECTIONS[lowerWord]) {
    return [TYPO_CORRECTIONS[lowerWord]];
  }
  
  // Find candidates within edit distance
  const similar: { word: string; distance: number }[] = [];
  for (const candidate of candidates) {
    const distance = levenshtein(lowerWord, candidate.toLowerCase());
    if (distance <= maxDistance && distance > 0) {
      similar.push({ word: candidate, distance });
    }
  }
  
  // Sort by distance and return top matches
  return similar
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map(s => s.word);
}

/**
 * Mini-notation parse result
 */
interface MiniParseResult {
  success: boolean;
  leaves?: Array<{
    type_: string;
    source_: string;
    location_: {
      start: { offset: number; line: number; column: number };
      end: { offset: number; line: number; column: number };
    };
  }>;
  error?: {
    message: string;
    location?: {
      start: { offset: number; line: number; column: number };
      end: { offset: number; line: number; column: number };
    };
    expected?: string[];
    found?: string;
  };
}

/**
 * Parse mini-notation using @strudel/mini parser
 * The parser expects the string WITH quotes, so we add them
 */
function parseMiniNotation(content: string): MiniParseResult {
  // Wrap content in quotes for the parser (it expects the full quoted string)
  const quotedContent = `"${content.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  
  try {
    // Use parse() directly to get the PEG.js error with location if it fails
    parseMini(quotedContent);
    
    // If parse succeeded, get the leaves (atoms) for further analysis
    const leaves = getMiniLeaves(quotedContent);
    return { success: true, leaves };
  } catch (e: any) {
    // Check if it's a PEG.js SyntaxError with location
    if (e && e.location) {
      return {
        success: false,
        error: {
          message: e.message,
          location: e.location,
          expected: e.expected?.map((exp: any) => {
            if (exp.type === 'literal') return `'${exp.text}'`;
            if (exp.description) return exp.description;
            return String(exp);
          }),
          found: e.found,
        },
      };
    }
    
    // Try to extract location from error message: "[mini] parse error at line X column Y:"
    const locMatch = e.message?.match(/line (\d+)(?: column (\d+))?/);
    if (locMatch) {
      const line = parseInt(locMatch[1], 10);
      const column = locMatch[2] ? parseInt(locMatch[2], 10) : 1;
      return {
        success: false,
        error: {
          message: e.message.replace(/^\[mini\] parse error at line \d+(?: column \d+)?:\s*/, ''),
          location: {
            start: { offset: 0, line, column },
            end: { offset: 0, line, column: column + 1 },
          },
        },
      };
    }
    
    // Generic error
    return {
      success: false,
      error: { message: e.message || 'Unknown parse error' },
    };
  }
}

// Store diagnostics with their data for code actions
interface DiagnosticData {
  type: 'unknown_sample' | 'unbalanced_bracket' | 'unknown_function';
  word?: string;
  suggestions?: string[];
}

const diagnosticDataMap = new Map<string, Map<string, DiagnosticData>>();

connection.onInitialize((params: InitializeParams): InitializeResult => {
  connection.console.log('Strudel LSP initializing...');
  
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        triggerCharacters: ['"', "'", ' ', ':', '(', '.', ','],
        resolveProvider: true,
      },
      hoverProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ['(', ','],
        retriggerCharacters: [','],
      },
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix],
      },
    },
  };
});

connection.onInitialized(() => {
  connection.console.log('Strudel LSP initialized');
  
  // Connect to engine and load samples
  connectToEngine();
});

/**
 * TCP client state for engine connection
 */
let engineSocket: import('net').Socket | null = null;
let engineBuffer = '';
let stopWatching: (() => void) | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

/**
 * Connect to the engine via TCP and request samples
 * Uses state file to get connection info, watches for engine restarts
 */
async function connectToEngine() {
  const net = await import('net');
  const { readEngineState, watchEngineState, isEngineRunning } = await import('./engine-state.js');
  
  // Function to attempt connection
  const tryConnect = (state: { port: number; pid: number }) => {
    if (engineSocket) {
      engineSocket.destroy();
      engineSocket = null;
    }
    
    connection.console.log(`Connecting to engine on port ${state.port}...`);
    
    const socket = net.createConnection({ port: state.port, host: '127.0.0.1' }, () => {
      connection.console.log('Connected to engine');
      engineSocket = socket;
      
      // Request samples, banks, and sounds
      socket.write(JSON.stringify({ type: 'getSamples' }) + '\n');
      socket.write(JSON.stringify({ type: 'getBanks' }) + '\n');
      socket.write(JSON.stringify({ type: 'getSounds' }) + '\n');
    });
    
    socket.on('data', (data) => {
      engineBuffer += data.toString();
      
      // Process newline-delimited JSON messages
      let newlineIndex;
      while ((newlineIndex = engineBuffer.indexOf('\n')) !== -1) {
        const line = engineBuffer.slice(0, newlineIndex);
        engineBuffer = engineBuffer.slice(newlineIndex + 1);
        
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            handleEngineMessage(msg);
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    });
    
    socket.on('error', (err) => {
      connection.console.log(`Engine connection error: ${err.message}`);
      engineSocket = null;
    });
    
    socket.on('close', () => {
      connection.console.log('Engine connection closed');
      engineSocket = null;
      engineBuffer = '';
    });
  };
  
  // Handle messages from engine
  const handleEngineMessage = (msg: any) => {
    switch (msg.type) {
      case 'samples':
        dynamicSamples = msg.samples || [];
        connection.console.log(`Received ${dynamicSamples.length} samples from engine`);
        // Re-validate all open documents
        documents.all().forEach(doc => validateDocument(doc));
        break;
      case 'banks':
        dynamicBanks = msg.banks || [];
        connection.console.log(`Received ${dynamicBanks.length} banks from engine`);
        // Re-validate all open documents
        documents.all().forEach(doc => validateDocument(doc));
        break;
      case 'sounds':
        // Could store synth sounds too if needed
        connection.console.log(`Received ${msg.sounds?.length || 0} sounds from engine`);
        break;
    }
  };
  
  // Initial connection attempt
  const state = readEngineState();
  if (state && isEngineRunning(state) && state.port > 0) {
    tryConnect(state);
  } else {
    connection.console.log('Engine not running, waiting for it to start...');
  }
  
  // Watch for engine starting/restarting
  stopWatching = watchEngineState((newState) => {
    if (newState && isEngineRunning(newState) && newState.port > 0) {
      // Clear any pending reconnect
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      
      // Small delay to let engine fully initialize
      reconnectTimer = setTimeout(() => {
        tryConnect(newState);
      }, 500);
    } else if (!newState) {
      connection.console.log('Engine stopped');
      if (engineSocket) {
        engineSocket.destroy();
        engineSocket = null;
      }
    }
  });
}

/**
 * Find if position is inside a mini-notation string (inside quotes)
 */
function findMiniNotationContext(document: TextDocument, position: Position): { inMini: boolean; content: string; startOffset: number } | null {
  const text = document.getText();
  const offset = document.offsetAt(position);
  
  // Look backwards for opening quote
  let quoteStart = -1;
  let quoteChar = '';
  for (let i = offset - 1; i >= 0; i--) {
    const char = text[i];
    if (char === '"' || char === "'") {
      // Check if escaped
      if (i > 0 && text[i - 1] === '\\') continue;
      quoteStart = i;
      quoteChar = char;
      break;
    }
    // Stop at newline or semicolon (likely not in same string)
    if (char === '\n' || char === ';') break;
  }
  
  if (quoteStart === -1) return null;
  
  // Look forward for closing quote
  let quoteEnd = -1;
  for (let i = offset; i < text.length; i++) {
    const char = text[i];
    if (char === quoteChar) {
      // Check if escaped
      if (i > 0 && text[i - 1] === '\\') continue;
      quoteEnd = i;
      break;
    }
    if (char === '\n') break;
  }
  
  if (quoteEnd === -1) return null;
  
  const content = text.slice(quoteStart + 1, quoteEnd);
  return { inMini: true, content, startOffset: quoteStart + 1 };
}

/**
 * Get current word at position
 */
function getCurrentWord(text: string, offset: number): string {
  let start = offset;
  let end = offset;
  
  // Go backwards to find word start
  while (start > 0 && /[a-zA-Z0-9_]/.test(text[start - 1])) {
    start--;
  }
  
  // Go forward to find word end
  while (end < text.length && /[a-zA-Z0-9_]/.test(text[end])) {
    end++;
  }
  
  return text.slice(start, end);
}

/**
 * Find function call context at position
 */
function findFunctionContext(text: string, offset: number): { name: string; paramIndex: number } | null {
  let depth = 0;
  let paramIndex = 0;
  
  // Go backwards to find function name
  for (let i = offset - 1; i >= 0; i--) {
    const char = text[i];
    
    if (char === ')') {
      depth++;
    } else if (char === '(') {
      if (depth === 0) {
        // Found opening paren, now find function name
        let nameEnd = i;
        let nameStart = i - 1;
        while (nameStart >= 0 && /[a-zA-Z0-9_]/.test(text[nameStart])) {
          nameStart--;
        }
        nameStart++;
        
        if (nameStart < nameEnd) {
          const name = text.slice(nameStart, nameEnd);
          return { name, paramIndex };
        }
        return null;
      }
      depth--;
    } else if (char === ',' && depth === 0) {
      paramIndex++;
    } else if (char === '\n' || char === ';') {
      break;
    }
  }
  
  return null;
}

connection.onCompletion((params): CompletionItem[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  
  const text = document.getText();
  const offset = document.offsetAt(params.position);
  
  // Check if we're inside a mini-notation string
  const miniContext = findMiniNotationContext(document, params.position);
  
  const items: CompletionItem[] = [];
  
  if (miniContext?.inMini) {
    // Inside mini-notation - suggest samples and notes
    const localOffset = offset - miniContext.startOffset;
    const beforeCursor = miniContext.content.slice(0, localOffset);
    
    // Check if after a colon (sample index)
    if (beforeCursor.endsWith(':')) {
      // Suggest sample indices
      for (let i = 0; i < 16; i++) {
        items.push({
          label: String(i),
          kind: CompletionItemKind.Value,
          detail: `Sample variant ${i}`,
          sortText: String(i).padStart(2, '0'),
        });
      }
      return items;
    }
    
    // Suggest samples
    const samples = getAllSamples();
    for (const sample of samples) {
      items.push({
        label: sample,
        kind: CompletionItemKind.Value,
        detail: 'Sample',
        documentation: `Play ${sample} sound`,
      });
    }
    
    // Suggest notes with octaves
    for (const note of NOTE_NAMES) {
      for (const octave of OCTAVES) {
        items.push({
          label: `${note}${octave}`,
          kind: CompletionItemKind.Value,
          detail: 'Note',
          documentation: `Note ${note.toUpperCase()}${octave}`,
          sortText: `1${note}${octave}`, // Sort notes after samples
        });
      }
    }
    
    // Suggest mini-notation operators
    for (const op of MINI_OPERATORS) {
      items.push({
        label: op.label,
        kind: CompletionItemKind.Operator,
        detail: op.detail,
        documentation: op.documentation,
        sortText: `2${op.label}`, // Sort operators last
      });
    }
  } else {
    // Outside mini-notation - suggest Strudel functions
    
    // Check if we're after a dot (method call)
    const beforeCursor = text.slice(Math.max(0, offset - 50), offset);
    const afterDot = beforeCursor.match(/\.\s*([a-zA-Z]*)$/);
    
    for (const func of STRUDEL_FUNCTIONS) {
      items.push({
        label: func.name,
        kind: CompletionItemKind.Function,
        detail: func.detail,
        documentation: {
          kind: MarkupKind.Markdown,
          value: `${func.documentation}\n\n\`\`\`javascript\n${func.signatures[0].label}\n\`\`\``,
        },
        insertText: afterDot ? `${func.name}($1)` : `${func.name}($1)`,
        insertTextFormat: 2, // Snippet
      });
    }
    
    // Suggest scales
    for (const scale of SCALE_NAMES) {
      items.push({
        label: scale,
        kind: CompletionItemKind.Enum,
        detail: 'Scale',
        documentation: `${scale} scale`,
      });
    }
    
    // Suggest banks if typing .bank(
    if (beforeCursor.includes('.bank(')) {
      const banks = dynamicBanks.length > 0 ? dynamicBanks : ['RolandTR808', 'RolandTR909', 'RolandTR707'];
      for (const bank of banks) {
        items.push({
          label: bank,
          kind: CompletionItemKind.Module,
          detail: 'Sample bank',
          documentation: `Use ${bank} drum machine samples`,
        });
      }
    }
  }
  
  return items;
});

connection.onCompletionResolve((item): CompletionItem => {
  // Add more detail on resolve if needed
  return item;
});

connection.onSignatureHelp((params): SignatureHelp | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  
  const text = document.getText();
  const offset = document.offsetAt(params.position);
  
  // Find function context
  const funcContext = findFunctionContext(text, offset);
  if (!funcContext) return null;
  
  // Find matching function
  const func = STRUDEL_FUNCTIONS.find(f => f.name === funcContext.name);
  if (!func) return null;
  
  // Build signature help
  const signatures: SignatureInformation[] = func.signatures.map(sig => {
    const params: ParameterInformation[] = sig.parameters.map(p => ({
      label: p.label,
      documentation: {
        kind: MarkupKind.Markdown,
        value: p.documentation,
      },
    }));
    
    return {
      label: sig.label,
      documentation: sig.documentation || func.documentation,
      parameters: params,
    };
  });
  
  // Select best signature based on parameter count
  let activeSignature = 0;
  for (let i = 0; i < func.signatures.length; i++) {
    if (func.signatures[i].parameters.length > funcContext.paramIndex) {
      activeSignature = i;
      break;
    }
  }
  
  return {
    signatures,
    activeSignature,
    activeParameter: Math.min(funcContext.paramIndex, func.signatures[activeSignature]?.parameters.length - 1 || 0),
  };
});

connection.onHover((params): Hover | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  
  const text = document.getText();
  const offset = document.offsetAt(params.position);
  const word = getCurrentWord(text, offset);
  
  if (!word) return null;
  
  const samples = getAllSamples();
  
  // Check samples
  if (samples.includes(word)) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**${word}** - Sample\n\nPlay the ${word} sound.\n\n\`\`\`javascript\ns("${word}")\n\`\`\``,
      },
    };
  }
  
  // Check notes (strip octave)
  const noteBase = word.replace(/[0-9]/g, '');
  if (NOTE_NAMES.includes(noteBase)) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**${word}** - Note\n\nMusical note ${noteBase.toUpperCase()}${word.replace(/[^0-9]/g, '')}.\n\n\`\`\`javascript\nnote("${word}")\n\`\`\``,
      },
    };
  }
  
  // Check functions
  const func = STRUDEL_FUNCTIONS.find(f => f.name === word);
  if (func) {
    const sigExamples = func.signatures.map(s => s.label).join('\n');
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**${func.name}** - ${func.detail}\n\n${func.documentation}\n\n\`\`\`javascript\n${sigExamples}\n\`\`\``,
      },
    };
  }
  
  // Check scales
  if (SCALE_NAMES.includes(word)) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**${word}** - Scale\n\nMusical scale.\n\n\`\`\`javascript\n.scale("${word}")\n\`\`\``,
      },
    };
  }
  
  // Check mini operators
  const op = MINI_OPERATORS.find(o => o.label === word || o.label.includes(word));
  if (op) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**${op.label}** - ${op.detail}\n\n${op.documentation}`,
      },
    };
  }
  
  // Check banks
  if (dynamicBanks.includes(word)) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**${word}** - Sample Bank\n\nDrum machine sample bank.\n\n\`\`\`javascript\n.bank("${word}")\n\`\`\``,
      },
    };
  }
  
  return null;
});

/**
 * Validate document and produce diagnostics
 */
async function validateDocument(document: TextDocument): Promise<void> {
  const text = document.getText();
  const diagnostics: Diagnostic[] = [];
  const docData = new Map<string, DiagnosticData>();
  
  const samples = getAllSamples();
  const functionNames = STRUDEL_FUNCTIONS.map(f => f.name);
  
  // Find all quoted strings and validate mini-notation
  const stringRegex = /(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  let match;
  
  // Functions whose string arguments should NOT be validated as mini-notation samples
  // These take bank names, scale names, or other non-sample identifiers
  const nonSampleArgFunctions = ['bank', 'scale', 'mode', 'voicing', 'chord', 'struct', 'mask'];
  
  while ((match = stringRegex.exec(text)) !== null) {
    const content = match[2];
    const stringStartOffset = match.index; // Position of opening quote
    const contentStartOffset = match.index + 1; // Skip opening quote
    
    // Skip empty strings
    if (!content.trim()) continue;
    
    // Skip strings that look like paths or URLs
    if (content.includes('/') && (content.startsWith('http') || content.startsWith('.') || content.startsWith('github:'))) continue;
    
    // Skip strings that are clearly not mini-notation (contain common code patterns)
    if (content.includes('function') || content.includes('=>') || content.includes('return')) continue;
    
    // Check if this string is an argument to a function that doesn't take sample names
    // Look backwards from the quote to find the function call pattern: .funcName( or funcName(
    const beforeString = text.slice(Math.max(0, stringStartOffset - 50), stringStartOffset);
    const funcCallMatch = beforeString.match(/\.?(\w+)\s*\(\s*$/);
    if (funcCallMatch && nonSampleArgFunctions.includes(funcCallMatch[1])) {
      // This is an argument to bank(), scale(), etc. - skip sample validation
      continue;
    }
    
    // Parse using @strudel/mini for proper AST-based validation
    const parseResult = parseMiniNotation(content);
    
    if (!parseResult.success && parseResult.error) {
      // Report parser error with accurate location
      const error = parseResult.error;
      
      // Calculate position in document
      // Parser location is 1-indexed and includes the quote we added, so subtract 1 from column
      let errorOffset: number;
      if (error.location) {
        // Parser offset includes the quote char we wrapped, so subtract 1
        // But we want to point to the document position, so use contentStartOffset
        errorOffset = contentStartOffset + Math.max(0, error.location.start.offset - 1);
      } else {
        errorOffset = contentStartOffset;
      }
      
      const pos = document.positionAt(errorOffset);
      const endOffset = error.location 
        ? contentStartOffset + Math.max(0, error.location.end.offset - 1)
        : errorOffset + 1;
      const endPos = document.positionAt(Math.min(endOffset, stringStartOffset + match[0].length - 1));
      
      const range = Range.create(pos, endPos);
      const key = `${range.start.line}:${range.start.character}`;
      
      // Clean up the error message
      let message = error.message;
      if (error.expected && error.found !== undefined) {
        const expectedStr = error.expected.slice(0, 5).join(', ');
        const more = error.expected.length > 5 ? `, ... (${error.expected.length - 5} more)` : '';
        message = `Syntax error: expected ${expectedStr}${more} but found ${error.found === null ? 'end of input' : `'${error.found}'`}`;
      }
      
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range,
        message,
        source: 'strudel',
        code: 'parse-error',
      });
      
      docData.set(key, { type: 'unbalanced_bracket' });
    }
    
    // If parsing succeeded, validate the leaves (atoms) for unknown samples
    if (parseResult.success && parseResult.leaves) {
      for (const leaf of parseResult.leaves) {
        if (leaf.type_ !== 'atom') continue;
        
        const word = leaf.source_;
        
        // Skip if it looks like a note (with or without octave)
        if (/^[a-g][sb]?[0-9]?$/i.test(word)) continue;
        
        // Skip numbers and rests
        if (/^[0-9.-]+$/.test(word) || word === '~') continue;
        
        // Skip if it's a known sample
        if (samples.some(s => s.toLowerCase() === word.toLowerCase())) continue;
        
        // Skip if it's a known bank (banks can appear as sample prefixes)
        if (dynamicBanks.some(b => b.toLowerCase() === word.toLowerCase())) continue;
        
        // Skip common mini-notation atoms
        if (['x', 't', 'f', 'r', '-', '_'].includes(word.toLowerCase())) continue;
        
        // Skip if it looks like a variable reference
        if (/^[A-Z]/.test(word)) continue;
        
        // Skip voicing modes (used with .mode() like "above:c3", "below:c4")
        if (VOICING_MODES.includes(word.toLowerCase())) continue;
        
        // Skip scale names (used with .scale())
        if (SCALE_NAMES.includes(word.toLowerCase())) continue;
        
        // Calculate position in document
        // leaf.location_.start.offset is relative to the quoted string, subtract 1 for the quote we added
        const wordOffset = contentStartOffset + Math.max(0, leaf.location_.start.offset - 1);
        const wordEndOffset = contentStartOffset + Math.max(0, leaf.location_.end.offset - 1);
        
        const pos = document.positionAt(wordOffset);
        const endPos = document.positionAt(wordEndOffset);
        const range = Range.create(pos, endPos);
        const key = `${range.start.line}:${range.start.character}`;
        
        // Find similar samples for suggestion
        const suggestions = findSimilar(word, samples);
        
        const diagnostic: Diagnostic = {
          severity: suggestions.length > 0 ? DiagnosticSeverity.Warning : DiagnosticSeverity.Hint,
          range,
          message: suggestions.length > 0
            ? `Unknown sample '${word}'. Did you mean: ${suggestions.join(', ')}?`
            : `Unknown sample '${word}' (may work if loaded dynamically)`,
          source: 'strudel',
          code: 'unknown-sample',
        };
        
        diagnostics.push(diagnostic);
        docData.set(key, { type: 'unknown_sample', word, suggestions });
      }
    } else if (!parseResult.success) {
      // Fallback: if parsing failed, still try to identify unknown samples with simple regex
      // This helps users even when there are syntax errors
      const words = content.split(/[\s\[\]\{\}\(\)<>:*\/!?@~,|]+/).filter(w => w && !/^[0-9.-]+$/.test(w));
      for (const word of words) {
        // Skip if it looks like a note
        if (/^[a-g][sb]?[0-9]?$/i.test(word)) continue;
        // Skip if it's a known sample
        if (samples.some(s => s.toLowerCase() === word.toLowerCase())) continue;
        // Skip if it's a known bank
        if (dynamicBanks.some(b => b.toLowerCase() === word.toLowerCase())) continue;
        // Skip common words/operators
        if (['x', 't', 'f', 'r', '-', '_'].includes(word.toLowerCase())) continue;
        // Skip if it looks like a variable reference
        if (/^[A-Z]/.test(word)) continue;
        // Skip voicing modes and scale names
        if (VOICING_MODES.includes(word.toLowerCase())) continue;
        if (SCALE_NAMES.includes(word.toLowerCase())) continue;
        
        // Find position of this word in content
        const wordIndex = content.indexOf(word);
        if (wordIndex !== -1) {
          const pos = document.positionAt(contentStartOffset + wordIndex);
          const range = Range.create(pos, Position.create(pos.line, pos.character + word.length));
          const key = `${range.start.line}:${range.start.character}`;
          
          // Skip if we already reported this location
          if (docData.has(key)) continue;
          
          // Find similar samples for suggestion
          const suggestions = findSimilar(word, samples);
          
          const diagnostic: Diagnostic = {
            severity: suggestions.length > 0 ? DiagnosticSeverity.Warning : DiagnosticSeverity.Hint,
            range,
            message: suggestions.length > 0
              ? `Unknown sample '${word}'. Did you mean: ${suggestions.join(', ')}?`
              : `Unknown sample '${word}' (may work if loaded dynamically)`,
            source: 'strudel',
            code: 'unknown-sample',
          };
          
          diagnostics.push(diagnostic);
          docData.set(key, { type: 'unknown_sample', word, suggestions });
        }
      }
    }
  }
  
  // Check function calls outside strings
  const funcCallRegex = /\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  while ((match = funcCallRegex.exec(text)) !== null) {
    const funcName = match[1];
    const funcStart = match.index + 1; // After the dot
    
    // Skip if known function
    if (functionNames.includes(funcName)) continue;
    // Skip common method names
    if (['then', 'catch', 'map', 'filter', 'forEach', 'reduce', 'log', 'error', 'warn'].includes(funcName)) continue;
    
    const suggestions = findSimilar(funcName, functionNames);
    
    if (suggestions.length > 0) {
      const pos = document.positionAt(funcStart);
      const range = Range.create(pos, Position.create(pos.line, pos.character + funcName.length));
      const key = `${range.start.line}:${range.start.character}`;
      
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range,
        message: `Unknown function '${funcName}'. Did you mean: ${suggestions.join(', ')}?`,
        source: 'strudel',
        code: 'unknown-function',
      });
      
      docData.set(key, { type: 'unknown_function', word: funcName, suggestions });
    }
  }
  
  diagnosticDataMap.set(document.uri, docData);
  connection.sendDiagnostics({ uri: document.uri, diagnostics });
}

connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  
  const actions: CodeAction[] = [];
  const docData = diagnosticDataMap.get(document.uri);
  
  for (const diagnostic of params.context.diagnostics) {
    if (diagnostic.source !== 'strudel') continue;
    
    const key = `${diagnostic.range.start.line}:${diagnostic.range.start.character}`;
    const data = docData?.get(key);
    
    if (data?.suggestions && data.suggestions.length > 0) {
      for (const suggestion of data.suggestions) {
        actions.push({
          title: `Replace with '${suggestion}'`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          isPreferred: data.suggestions.indexOf(suggestion) === 0,
          edit: {
            changes: {
              [params.textDocument.uri]: [
                TextEdit.replace(diagnostic.range, suggestion),
              ],
            },
          },
        });
      }
    }
  }
  
  return actions;
});

// Validate on open and change
documents.onDidOpen((event) => {
  validateDocument(event.document);
});

documents.onDidChangeContent((event) => {
  validateDocument(event.document);
});

documents.onDidClose((event) => {
  diagnosticDataMap.delete(event.document.uri);
});

// Cleanup on shutdown
connection.onShutdown(() => {
  if (stopWatching) {
    stopWatching();
    stopWatching = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (engineSocket) {
    engineSocket.destroy();
    engineSocket = null;
  }
});

// Make the text document manager listen on the connection
documents.listen(connection);

// Listen on the connection
connection.listen();

console.error('[strudel-lsp] Server started');
