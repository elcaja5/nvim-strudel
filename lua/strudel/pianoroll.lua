---@brief [[
--- Pianoroll/Punchcard ASCII visualization for Strudel patterns
--- Shows pattern events as an animated ASCII display in a split buffer
---@brief ]]

local client = require('strudel.client')
local config = require('strudel.config')
local utils = require('strudel.utils')

local M = {}

---@class PianorollState
---@field bufnr number|nil Buffer number
---@field winid number|nil Window ID
---@field timer uv_timer_t|nil Animation timer
---@field tracks table[] Current track data
---@field cycle number Current cycle
---@field phase number Phase within cycle (0-1)
---@field display_cycles number Number of cycles to display
---@field width number Character width of the display
---@field ns_id number Namespace for extmarks

---@type PianorollState
local state = {
  bufnr = nil,
  winid = nil,
  timer = nil,
  tracks = {},
  cycle = 0,
  phase = 0,
  display_cycles = 2,
  width = 64,
  ns_id = vim.api.nvim_create_namespace('strudel_pianoroll'),
}

-- Unicode/ASCII characters for rendering
local CHARS = {
  event = '█',
  event_active = '▓',
  sustain = '░',
  empty = ' ',
  playhead = '▏',
  border_h = '─',
  border_v = '│',
  corner_tl = '┌',
  corner_tr = '┐',
  corner_bl = '└',
  corner_br = '┘',
  tick = '┬',
  tick_bottom = '┴',
}

---Create highlight groups for pianoroll
local function setup_highlights()
  -- Track name labels
  vim.api.nvim_set_hl(0, 'StrudelPianoTrack', {
    default = true,
    link = 'Identifier',
  })

  -- Event block (inactive)
  vim.api.nvim_set_hl(0, 'StrudelPianoEvent', {
    default = true,
    link = 'Function',
  })

  -- Active event (currently sounding)
  vim.api.nvim_set_hl(0, 'StrudelPianoActive', {
    default = true,
    link = 'Search',
  })

  -- Playhead line
  vim.api.nvim_set_hl(0, 'StrudelPianoPlayhead', {
    default = true,
    link = 'WarningMsg',
  })

  -- Border
  vim.api.nvim_set_hl(0, 'StrudelPianoBorder', {
    default = true,
    link = 'FloatBorder',
  })

  -- Empty space
  vim.api.nvim_set_hl(0, 'StrudelPianoEmpty', {
    default = true,
    link = 'Comment',
  })
end

---Get the maximum track name length
---@param tracks table[]
---@return number
local function max_track_name_len(tracks)
  local max_len = 4 -- minimum
  for _, track in ipairs(tracks) do
    max_len = math.max(max_len, #track.name)
  end
  return math.min(max_len, 12) -- cap at 12
end

---Render a single track line
---@param track table
---@param width number
---@param phase number
---@return string line
---@return table highlights {col_start, col_end, hl_group}[]
local function render_track_line(track, width, phase)
  local line = {}
  local highlights = {}

  -- Create empty line
  for i = 1, width do
    line[i] = CHARS.empty
  end

  -- Draw events
  for _, event in ipairs(track.events) do
    local start_col = math.floor(event.start * width) + 1
    local end_col = math.ceil(event["end"] * width)

    -- Clamp to bounds
    start_col = math.max(1, math.min(width, start_col))
    end_col = math.max(1, math.min(width, end_col))

    -- Draw the event
    for col = start_col, end_col do
      if event.active then
        line[col] = CHARS.event_active
      else
        line[col] = CHARS.event
      end
    end

    -- Add highlight
    table.insert(highlights, {
      col_start = start_col - 1,
      col_end = end_col,
      hl_group = event.active and 'StrudelPianoActive' or 'StrudelPianoEvent',
    })
  end

  -- Draw playhead
  local playhead_col = math.floor(phase * width / state.display_cycles) + 1
  if playhead_col >= 1 and playhead_col <= width then
    -- Only replace if it's empty space
    if line[playhead_col] == CHARS.empty then
      line[playhead_col] = CHARS.playhead
    end
    table.insert(highlights, {
      col_start = playhead_col - 1,
      col_end = playhead_col,
      hl_group = 'StrudelPianoPlayhead',
    })
  end

  return table.concat(line), highlights
end

---Render the visualization to the buffer
---@param tracks table[]
---@param cycle number
---@param phase number
local function render(tracks, cycle, phase)
  if not state.bufnr or not vim.api.nvim_buf_is_valid(state.bufnr) then
    return
  end

  local label_width = max_track_name_len(tracks)
  local content_width = state.width - label_width - 3 -- -3 for " │ "

  local lines = {}
  local all_highlights = {}

  -- Header with cycle info
  local header = string.format(' Cycle: %.2f ', cycle)
  local header_line = CHARS.corner_tl
    .. string.rep(CHARS.border_h, label_width)
    .. CHARS.tick
    .. string.rep(CHARS.border_h, content_width)
    .. CHARS.corner_tr
  table.insert(lines, header_line)

  -- Track lines
  for i, track in ipairs(tracks) do
    local label = track.name:sub(1, label_width)
    label = label .. string.rep(' ', label_width - #label) -- pad

    local content, highlights = render_track_line(track, content_width, phase)

    local line = CHARS.border_v .. label .. CHARS.border_v .. content .. CHARS.border_v
    table.insert(lines, line)

    -- Adjust highlight positions for the label offset
    local offset = 1 + label_width + 1
    for _, hl in ipairs(highlights) do
      table.insert(all_highlights, {
        line = i, -- 0-indexed later
        col_start = offset + hl.col_start,
        col_end = offset + hl.col_end,
        hl_group = hl.hl_group,
      })
    end

    -- Add label highlight
    table.insert(all_highlights, {
      line = i,
      col_start = 1,
      col_end = 1 + label_width,
      hl_group = 'StrudelPianoTrack',
    })
  end

  -- Footer
  local footer_line = CHARS.corner_bl
    .. string.rep(CHARS.border_h, label_width)
    .. CHARS.tick_bottom
    .. string.rep(CHARS.border_h, content_width)
    .. CHARS.corner_br
  table.insert(lines, footer_line)

  -- If no tracks, show a message
  if #tracks == 0 then
    lines = {
      CHARS.corner_tl .. string.rep(CHARS.border_h, state.width - 2) .. CHARS.corner_tr,
      CHARS.border_v .. string.rep(' ', 10) .. 'No pattern playing' .. string.rep(' ', state.width - 30) .. CHARS.border_v,
      CHARS.corner_bl .. string.rep(CHARS.border_h, state.width - 2) .. CHARS.corner_br,
    }
    all_highlights = {}
  end

  -- Update buffer
  vim.api.nvim_set_option_value('modifiable', true, { buf = state.bufnr })
  vim.api.nvim_buf_set_lines(state.bufnr, 0, -1, false, lines)
  vim.api.nvim_set_option_value('modifiable', false, { buf = state.bufnr })

  -- Clear old highlights
  vim.api.nvim_buf_clear_namespace(state.bufnr, state.ns_id, 0, -1)

  -- Apply highlights
  for _, hl in ipairs(all_highlights) do
    vim.api.nvim_buf_add_highlight(
      state.bufnr,
      state.ns_id,
      hl.hl_group,
      hl.line, -- already 0-indexed relative to tracks
      hl.col_start,
      hl.col_end
    )
  end

  -- Border highlights
  for i = 0, #lines - 1 do
    vim.api.nvim_buf_add_highlight(state.bufnr, state.ns_id, 'StrudelPianoBorder', i, 0, 1)
    vim.api.nvim_buf_add_highlight(state.bufnr, state.ns_id, 'StrudelPianoBorder', i, #lines[i + 1] - 1, #lines[i + 1])
  end
  vim.api.nvim_buf_add_highlight(state.bufnr, state.ns_id, 'StrudelPianoBorder', 0, 0, -1)
  vim.api.nvim_buf_add_highlight(state.bufnr, state.ns_id, 'StrudelPianoBorder', #lines - 1, 0, -1)
end

---Handle visualization data from server
---@param msg table
local function on_visualization(msg)
  state.tracks = msg.tracks or {}
  state.cycle = msg.cycle or 0
  state.phase = msg.phase or 0
  state.display_cycles = msg.displayCycles or 2

  vim.schedule(function()
    render(state.tracks, state.cycle, state.phase)
  end)
end

---Request visualization data from server
local function request_visualization()
  if not client.is_connected() then
    return
  end

  client.send({
    type = 'queryVisualization',
    cycles = state.display_cycles,
  })
end

---Start the animation timer
local function start_timer()
  if state.timer then
    return
  end

  state.timer = vim.uv.new_timer()
  if state.timer then
    state.timer:start(0, 50, vim.schedule_wrap(function()
      request_visualization()
    end))
    utils.debug('Pianoroll animation started')
  end
end

---Stop the animation timer
local function stop_timer()
  if state.timer then
    state.timer:stop()
    state.timer:close()
    state.timer = nil
    utils.debug('Pianoroll animation stopped')
  end
end

---Create the pianoroll buffer and window
function M.open()
  -- Check if already open
  if state.winid and vim.api.nvim_win_is_valid(state.winid) then
    vim.api.nvim_set_current_win(state.winid)
    return
  end

  setup_highlights()

  -- Create buffer
  state.bufnr = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_set_option_value('buftype', 'nofile', { buf = state.bufnr })
  vim.api.nvim_set_option_value('bufhidden', 'wipe', { buf = state.bufnr })
  vim.api.nvim_set_option_value('swapfile', false, { buf = state.bufnr })
  vim.api.nvim_buf_set_name(state.bufnr, 'Strudel Pianoroll')

  -- Calculate window dimensions
  local cfg = config.get()
  local height = cfg.pianoroll and cfg.pianoroll.height or 10
  state.width = cfg.pianoroll and cfg.pianoroll.width or 64

  -- Create horizontal split at bottom
  local current_win = vim.api.nvim_get_current_win()
  vim.cmd('botright ' .. height .. 'split')
  state.winid = vim.api.nvim_get_current_win()

  -- Set buffer in window
  vim.api.nvim_win_set_buf(state.winid, state.bufnr)

  -- Window options
  vim.api.nvim_set_option_value('number', false, { win = state.winid })
  vim.api.nvim_set_option_value('relativenumber', false, { win = state.winid })
  vim.api.nvim_set_option_value('signcolumn', 'no', { win = state.winid })
  vim.api.nvim_set_option_value('winfixheight', true, { win = state.winid })
  vim.api.nvim_set_option_value('cursorline', false, { win = state.winid })
  vim.api.nvim_set_option_value('wrap', false, { win = state.winid })

  -- Return to original window
  vim.api.nvim_set_current_win(current_win)

  -- Register for visualization messages
  client.on('visualization', on_visualization)

  -- Start animation timer
  start_timer()

  -- Initial render
  render({}, 0, 0)

  -- Set up autocommand to clean up when buffer is wiped
  vim.api.nvim_create_autocmd('BufWipeout', {
    buffer = state.bufnr,
    once = true,
    callback = function()
      stop_timer()
      state.bufnr = nil
      state.winid = nil
    end,
  })

  utils.log('Pianoroll opened')
end

---Close the pianoroll window
function M.close()
  stop_timer()

  if state.winid and vim.api.nvim_win_is_valid(state.winid) then
    vim.api.nvim_win_close(state.winid, true)
  end

  state.winid = nil
  state.bufnr = nil

  utils.log('Pianoroll closed')
end

---Toggle the pianoroll window
function M.toggle()
  if state.winid and vim.api.nvim_win_is_valid(state.winid) then
    M.close()
  else
    M.open()
  end
end

---Check if pianoroll is open
---@return boolean
function M.is_open()
  return state.winid ~= nil and vim.api.nvim_win_is_valid(state.winid)
end

---Set the number of cycles to display
---@param cycles number
function M.set_display_cycles(cycles)
  state.display_cycles = math.max(1, math.min(8, cycles))
end

---Set the display width
---@param width number
function M.set_width(width)
  state.width = math.max(32, math.min(200, width))
end

return M
