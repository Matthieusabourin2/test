-- Activates Claude Desktop and clicks the sidebar row whose visible title
-- matches the argument. Walks the AX tree breadth-first so it works
-- regardless of which subsection (Code / Cowork / Chat) the session is in.
--
-- Usage:
--   osascript open-session.applescript "My session title"

on run argv
	if (count of argv) is 0 then
		return "error: missing title argument"
	end if
	set targetTitle to item 1 of argv

	tell application "Claude" to activate
	delay 0.25

	tell application "System Events"
		if not (exists process "Claude") then
			return "error: Claude process not running"
		end if
		tell process "Claude"
			set frontmost to true
			-- Walk all windows looking for the row.
			repeat with w in windows
				set found to my findAndClick(w, targetTitle)
				if found is not false then return "ok: clicked " & targetTitle
			end repeat
		end tell
	end tell
	return "miss: no row found matching " & targetTitle
end run

-- Recursive breadth-first walk: looks at name, title, value, and description
-- attributes for a substring match, then clicks the first match.
on findAndClick(elem, target)
	tell application "System Events"
		try
			set attrs to {}
			try
				set end of attrs to (name of elem as string)
			end try
			try
				set end of attrs to (title of elem as string)
			end try
			try
				set end of attrs to (value of elem as string)
			end try
			try
				set end of attrs to (description of elem as string)
			end try
			repeat with a in attrs
				if (a as string) contains target then
					try
						click elem
						return true
					on error
						-- Some AX elements aren't directly clickable;
						-- try perform AXPress on them.
						try
							perform action "AXPress" of elem
							return true
						end try
					end try
				end if
			end repeat
		end try
		try
			set kids to UI elements of elem
			repeat with k in kids
				set res to my findAndClick(k, target)
				if res is not false then return res
			end repeat
		end try
		return false
	end tell
end findAndClick
