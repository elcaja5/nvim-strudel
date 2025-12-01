# nvim-strudel

Live code music in Neovim with [Strudel](https://strudel.cc/).

nvim-strudel brings the Strudel live coding music environment to Neovim, providing real-time visualization of active pattern elements and full playback control.

## Features

- Live code music patterns directly in Neovim
- Real-time visual feedback showing which code elements are currently producing sound
- Full playback control (play, pause, stop, hush)
- Pianoroll visualization (auto-shows when playing, hides when stopped)
- LSP support for mini-notation (completions, hover, diagnostics)
- All default Strudel samples available (piano, drums, synths, etc.)
- OSC output to SuperDirt/SuperCollider (optional)

## Requirements

- Neovim >= 0.9.0
- Node.js >= 18.0
- Audio output device

## Installation

### Using lazy.nvim

```lua
{
  'Goshujinsama/nvim-strudel',
  ft = { 'strudel', 'javascript', 'typescript' },
  cmd = { 'StrudelPlay', 'StrudelEval', 'StrudelConnect' },
  build = 'cd server && npm install && npm run build',
  opts = {
    -- See Configuration below
  },
}
```

The `build` step automatically compiles the backend server when the plugin is installed or updated.

## Quick Start

1. Open a `.strudel` or `.js` file
2. Write a Strudel pattern:
   ```javascript
   s("bd sd bd sd").fast(2)
   ```
3. Start playback: `:StrudelPlay` (auto-connects and auto-evals)
4. Hear your music!

## Configuration

```lua
require('strudel').setup({
  -- Server connection
  server = {
    host = '127.0.0.1',
    port = 37812,
    auto_start = true,  -- Start server automatically on :StrudelConnect
  },

  -- Visualization highlights
  highlight = {
    active = 'StrudelActive',   -- Currently sounding element
    pending = 'StrudelPending', -- Element about to sound
    muted = 'StrudelMuted',     -- Muted element
  },

  -- Pianoroll visualization
  pianoroll = {
    height = 10,          -- Height of pianoroll window
    display_cycles = 2,   -- Number of cycles to show
    mode = 'auto',        -- 'auto', 'tracks', 'notes', or 'drums'
  },

  -- Keymaps (disabled by default, opt-in)
  keymaps = {
    enabled = false,      -- Set to true to enable keymaps
    eval = '<C-CR>',      -- Ctrl+Enter to evaluate (like Strudel web UI)
    play = '<leader>sp',  -- Play/resume
    stop = '<leader>ss',  -- Stop
    pause = '<leader>sx', -- Pause
    hush = '<leader>sh',  -- Hush (silence all immediately)
  },

  -- LSP for mini-notation
  lsp = {
    enabled = true,       -- Enable LSP (completions, hover, diagnostics)
  },

  -- Picker backend: 'auto', 'snacks', or 'telescope'
  picker = 'auto',

  -- Auto-evaluate on save
  auto_eval = false,

  -- File types to activate for
  filetypes = { 'strudel', 'javascript', 'typescript' },
})
```

## Commands

| Command | Description |
|---------|-------------|
| `:StrudelPlay` | Start playback (auto-connects and auto-evals if needed) |
| `:StrudelPause` | Pause playback |
| `:StrudelStop` | Stop playback and reset |
| `:StrudelHush` | Stop and silence all sounds immediately |
| `:StrudelEval` | Evaluate current buffer or selection (auto-connects if needed) |
| `:StrudelConnect` | Connect to server (auto-starts server if needed) |
| `:StrudelDisconnect` | Disconnect and stop server |
| `:StrudelStatus` | Show connection, server, and pianoroll status |
| `:StrudelPianoroll` | Toggle pianoroll visualization |
| `:StrudelSamples` | Browse available samples |
| `:StrudelSounds` | Browse available sounds |
| `:StrudelBanks` | Browse sample banks |
| `:StrudelPatterns` | Browse saved patterns |

## Pianoroll

The pianoroll provides a visual representation of your pattern. It automatically shows when playback starts and hides when stopped.

- Toggle with `:StrudelPianoroll`
- Stays visible when paused
- Supports multiple visualization modes: `auto`, `tracks`, `notes`, `drums`
- Pattern code using `.pianoroll()` or `.punchcard()` auto-enables visualization

## Keymaps

Keymaps are disabled by default. To enable them, set `keymaps.enabled = true` in your config.

When enabled, these keymaps are set for `strudel`, `javascript`, and `typescript` files:

| Key | Mode | Action |
|-----|------|--------|
| `Ctrl+Enter` | n, v, i | Evaluate buffer/selection |
| `<leader>sp` | n | Play |
| `<leader>ss` | n | Stop |
| `<leader>sx` | n | Pause |
| `<leader>sh` | n | Hush (silence all) |

You can customize the keys in your config, or define your own keymaps manually:

```lua
vim.keymap.set('n', '<leader>se', '<cmd>StrudelEval<cr>', { desc = 'Strudel Eval' })
```

## LSP (Language Server)

nvim-strudel includes an LSP server for mini-notation that provides:

- **Completions**: Sample names, notes, scales, and mini-notation operators
- **Hover**: Documentation for samples, notes, and Strudel functions
- **Diagnostics**: Bracket matching errors and unknown sample warnings

The LSP starts automatically for configured filetypes. To disable:

```lua
require('strudel').setup({
  lsp = { enabled = false },
})
```

## Running the Server Manually

The server auto-starts by default. To run manually:

```bash
cd server
node dist/index.js
```

Environment variables:
- `STRUDEL_PORT` - Server port (default: 37812)
- `STRUDEL_HOST` - Server host (default: 127.0.0.1)
- `STRUDEL_USE_OSC=1` - Enable OSC output to SuperDirt
- `STRUDEL_OSC_HOST` - SuperDirt host (default: 127.0.0.1)
- `STRUDEL_OSC_PORT` - SuperDirt port (default: 57120)

## Highlighting

Active elements are highlighted as they play. By default, highlights link to standard Neovim groups so they respect your colorscheme:

| Highlight Group | Default Link | Purpose |
|-----------------|--------------|---------|
| `StrudelActive` | `Search` | Currently sounding element |
| `StrudelPending` | `Visual` | Element about to sound |
| `StrudelMuted` | `Comment` | Muted/inactive element |
| `StrudelPlayhead` | `WarningMsg` | Playhead indicator |
| `StrudelConnected` | `DiagnosticOk` | Connected status |
| `StrudelDisconnected` | `DiagnosticError` | Disconnected status |
| `StrudelError` | `DiagnosticUnderlineError` | Error underline |

To customize, override in your config (after colorscheme loads):

```lua
vim.api.nvim_set_hl(0, 'StrudelActive', { bg = '#3d5c3d', bold = true })
vim.api.nvim_set_hl(0, 'StrudelPending', { link = 'CursorLine' })
```

## SuperDirt / SuperCollider

To use SuperDirt for audio output instead of (or in addition to) Web Audio:

1. Start SuperCollider with SuperDirt
2. Set environment variable: `STRUDEL_USE_OSC=1`
3. Start the server (or restart if already running)

## License

AGPL-3.0 - Required due to dependency on Strudel libraries.

## Acknowledgments

- [Strudel](https://strudel.cc/) by Felix Roos and contributors
- [TidalCycles](https://tidalcycles.org/) for the pattern language inspiration
