-- Activate Claude Desktop and open the matching conversation via the Cmd+K
-- "Recherche" (Search) palette. This is dramatically faster than walking the
-- AX tree to find and click the sidebar row.
--
-- Flow:
--   1. activate Claude Desktop (open a window if none)
--   2. send Cmd+K to open the search palette
--   3. type the title (truncated to first 60 chars)
--   4. wait briefly for the result list to populate
--   5. press Return — selects the top match
--
-- Returns "ok: ..." on send success, "error: ..." otherwise.

on run argv
	if (count of argv) is 0 then return "error: missing title argument"
	set targetTitle to item 1 of argv
	-- Truncate to first ~50 chars to keep the search query short and unambiguous
	if (length of targetTitle) > 50 then set targetTitle to text 1 thru 50 of targetTitle

	try
		tell application "Claude" to activate
	on error errMsg
		return "error: claude not running (" & errMsg & ")"
	end try

	delay 0.4

	tell application "System Events"
		if not (exists process "Claude") then return "error: claude process missing"
		tell process "Claude"
			try
				set frontmost to true
			end try
		end tell

		-- Close any existing modal/popup first (Escape twice to be safe)
		key code 53
		delay 0.1
		key code 53
		delay 0.2

		-- Open Recherche palette
		keystroke "k" using command down
		delay 0.5

		-- Type the search query
		keystroke targetTitle
		delay 0.7

		-- Press Return to select top match
		key code 36
	end tell

	return "ok: search-and-enter " & targetTitle
end run
