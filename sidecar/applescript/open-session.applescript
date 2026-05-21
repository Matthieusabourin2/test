-- Open the matching conversation in Claude Desktop via the Cmd+K search
-- palette.
--
-- Critical: macOS focus-stealing protection means `tell app "Claude" to
-- activate` doesn't take effect instantly when another app is frontmost
-- (e.g. the browser running the dashboard). We have to actively poll for
-- Claude to become frontmost before sending keystrokes — otherwise Cmd+K
-- and the title end up typed into the browser's address bar.
--
-- Returns "ok: ..." on send completion, "error: ..." otherwise.

on run argv
	if (count of argv) is 0 then return "error: missing title argument"
	set targetTitle to item 1 of argv
	if (length of targetTitle) > 50 then set targetTitle to text 1 thru 50 of targetTitle

	-- Trigger activate
	try
		tell application "Claude" to activate
	on error errMsg
		return "error: claude not running (" & errMsg & ")"
	end try

	-- Poll up to 4s for Claude to actually become frontmost.
	-- Re-issue `activate` every 500ms in case the first call was lost.
	set isFront to false
	set waited to 0
	repeat 40 times
		tell application "System Events"
			if (exists process "Claude") then
				if frontmost of process "Claude" then
					set isFront to true
					exit repeat
				end if
			end if
		end tell
		if waited mod 5 is 0 then
			try
				tell application "Claude" to activate
			end try
		end if
		delay 0.1
		set waited to waited + 1
	end repeat

	if not isFront then
		return "error: Claude won't take focus (frontmost=" & (do shell script "osascript -e 'tell application \"System Events\" to get name of first process whose frontmost is true'") & "). Try clicking Claude's Dock icon once."
	end if

	tell application "System Events"
		tell process "Claude"
			set frontmost to true
			delay 0.2

			-- Close any palette / modal already open
			key code 53 -- Escape
			delay 0.15
			key code 53
			delay 0.2

			-- Open Recherche palette
			keystroke "k" using command down
			delay 0.7

			-- Type the search query
			keystroke targetTitle
			delay 0.9

			-- Press Return to select top match
			key code 36
		end tell
	end tell

	return "ok: search-and-enter " & targetTitle
end run
