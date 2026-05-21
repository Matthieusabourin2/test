-- Activates Claude Desktop and clicks the sidebar row whose visible title
-- matches the argument. Returns one of: ok / miss / error.

on run argv
	if (count of argv) is 0 then return "error: missing title argument"
	set targetTitle to item 1 of argv
	if (length of targetTitle) > 40 then set targetTitle to text 1 thru 40 of targetTitle

	try
		tell application "Claude" to activate
	on error
		return "error: claude not running"
	end try
	delay 0.2

	tell application "System Events"
		if not (exists process "Claude") then return "error: claude process missing"
		tell process "Claude"
			try
				set frontmost to true
			end try
			repeat with w in windows
				try
					set hit to my findAndClick(w, targetTitle, 0)
					if hit is true then return "ok: clicked " & targetTitle
				end try
			end repeat
		end tell
	end tell
	return "miss: no row found matching " & targetTitle
end run

on findAndClick(elem, target, depth)
	if depth > 18 then return false
	set tLow to my toLower(target)
	tell application "System Events"
		try
			set candidates to {}
			try
				set end of candidates to (name of elem as string)
			end try
			try
				set end of candidates to (title of elem as string)
			end try
			try
				set end of candidates to (value of elem as string)
			end try
			try
				set end of candidates to (description of elem as string)
			end try
			repeat with a in candidates
				try
					if (my toLower(a as string)) contains tLow then
						try
							perform action "AXPress" of elem
							return true
						on error
							try
								click elem
								return true
							end try
						end try
					end if
				end try
			end repeat
		end try
		try
			set kids to UI elements of elem
			repeat with k in kids
				set res to my findAndClick(k, target, depth + 1)
				if res is true then return true
			end repeat
		end try
		return false
	end tell
end findAndClick

on toLower(s)
	try
		return (do shell script "printf %s " & quoted form of (s as string) & " | /usr/bin/tr '[:upper:]' '[:lower:]'")
	on error
		return s
	end try
end toLower
