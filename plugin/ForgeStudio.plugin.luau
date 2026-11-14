-- ForgeStudio plugin for Roblox Studio (protocol 1)
-- Install: put this file in your Roblox Plugins folder, then restart Studio.

local ENDPOINT = "__ENDPOINT__"
local VERSION = "0.2.0"
local PROTOCOL = 1
local POLL_SECONDS = 5
local TREE_EVERY = 6

local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local RunService = game:GetService("RunService")

if RunService:IsRunning() then
	return
end

local SERVICES = {
	"Workspace", "Lighting", "ReplicatedFirst", "ReplicatedStorage", "ServerScriptService",
	"ServerStorage", "StarterGui", "StarterPack", "StarterPlayer", "SoundService", "Teams",
}

local GREEN = Color3.fromRGB(101, 230, 177)
local RED = Color3.fromRGB(255, 120, 120)
local GREY = Color3.fromRGB(146, 153, 173)
local WHITE = Color3.fromRGB(245, 246, 250)

-- Pairing is stored per published place. Unpublished places are paired for this session only.
local persist = game.PlaceId ~= 0
local tokenKey = "ForgeStudioToken_" .. tostring(game.PlaceId)
local token = nil
if persist then
	local saved = plugin:GetSetting(tokenKey)
	if type(saved) == "string" and saved ~= "" then
		token = saved
	end
end

local applied = {}
local busy = false
local polls = 0

-- Stops the check-in loop when Studio unloads or reloads this plugin.
local running = true
plugin.Unloading:Connect(function()
	running = false
end)

local toolbar = plugin:CreateToolbar("ForgeStudio")
local toolbarButton = toolbar:CreateButton("ForgeStudio", "Open the ForgeStudio panel", "")
local widgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 320, 440, 260, 320)
local widget = plugin:CreateDockWidgetPluginGui("ForgeStudioPanel", widgetInfo)
widget.Title = "ForgeStudio"
toolbarButton.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

local root = Instance.new("Frame")
root.Size = UDim2.new(1, 0, 1, 0)
root.BackgroundColor3 = Color3.fromRGB(16, 18, 26)
root.BorderSizePixel = 0
root.Parent = widget

local padding = Instance.new("UIPadding")
padding.PaddingTop = UDim.new(0, 12)
padding.PaddingBottom = UDim.new(0, 12)
padding.PaddingLeft = UDim.new(0, 12)
padding.PaddingRight = UDim.new(0, 12)
padding.Parent = root

local layout = Instance.new("UIListLayout")
layout.Padding = UDim.new(0, 8)
layout.SortOrder = Enum.SortOrder.LayoutOrder
layout.Parent = root

local function makeLabel(text, order, height, color, size)
	local label = Instance.new("TextLabel")
	label.BackgroundTransparency = 1
	label.Size = UDim2.new(1, 0, 0, height)
	label.Font = Enum.Font.SourceSans
	label.TextSize = size
	label.TextColor3 = color
	label.TextXAlignment = Enum.TextXAlignment.Left
	label.TextYAlignment = Enum.TextYAlignment.Top
	label.TextWrapped = true
	label.Text = text
	label.LayoutOrder = order
	label.Parent = root
	return label
end

local function makeButton(text, order, color)
	local button = Instance.new("TextButton")
	button.Size = UDim2.new(1, 0, 0, 30)
	button.BackgroundColor3 = color
	button.BorderSizePixel = 0
	button.Font = Enum.Font.SourceSansSemibold
	button.TextSize = 15
	button.TextColor3 = WHITE
	button.Text = text
	button.LayoutOrder = order
	button.Parent = root
	return button
end

makeLabel("ForgeStudio  v" .. VERSION, 1, 20, WHITE, 17)
local statusLabel = makeLabel("Not paired. Enter a pairing code from your project.", 2, 40, GREY, 15)

local codeBox = Instance.new("TextBox")
codeBox.Size = UDim2.new(1, 0, 0, 30)
codeBox.BackgroundColor3 = Color3.fromRGB(23, 26, 36)
codeBox.BorderSizePixel = 0
codeBox.Font = Enum.Font.Code
codeBox.TextSize = 16
codeBox.TextColor3 = WHITE
codeBox.PlaceholderText = "Pairing code"
codeBox.Text = ""
codeBox.ClearTextOnFocus = false
codeBox.LayoutOrder = 3
codeBox.Parent = root

local pairButton = makeButton("Pair this place", 4, Color3.fromRGB(132, 101, 255))
local disconnectButton = makeButton("Disconnect", 5, Color3.fromRGB(38, 42, 56))
local logLabel = makeLabel("", 6, 220, GREY, 14)

local logLines = {}
local function log(message)
	table.insert(logLines, os.date("%H:%M:%S") .. "  " .. message)
	while #logLines > 10 do
		table.remove(logLines, 1)
	end
	logLabel.Text = table.concat(logLines, "\n")
end

local function setStatus(text, color)
	statusLabel.Text = text
	statusLabel.TextColor3 = color
end

local function clearToken()
	token = nil
	if persist then
		plugin:SetSetting(tokenKey, "")
	end
end

local function request(payload)
	local sent, response = pcall(function()
		return HttpService:RequestAsync({
			Url = ENDPOINT,
			Method = "POST",
			Headers = { ["Content-Type"] = "application/json" },
			Body = HttpService:JSONEncode(payload),
		})
	end)
	if not sent then
		return nil, tostring(response), 0
	end
	local decoded, data = pcall(function()
		return HttpService:JSONDecode(response.Body)
	end)
	if not decoded or type(data) ~= "table" then
		return nil, "Unreadable response (HTTP " .. tostring(response.StatusCode) .. ")", response.StatusCode
	end
	if not response.Success then
		return nil, tostring(data.error or ("HTTP " .. tostring(response.StatusCode))), response.StatusCode
	end
	return data, nil, response.StatusCode
end

local function buildTree()
	local count = 0
	local function describe(instance, depth)
		count += 1
		local entry = { n = string.sub(instance.Name, 1, 60), c = instance.ClassName }
		if depth < 4 then
			local children = instance:GetChildren()
			if #children > 0 then
				local list = {}
				for index, child in ipairs(children) do
					if index > 40 or count > 600 then
						break
					end
					table.insert(list, describe(child, depth + 1))
				end
				entry.k = list
				if #children > #list then
					entry.more = #children - #list
				end
			end
		end
		return entry
	end
	local services = {}
	for _, name in ipairs(SERVICES) do
		local found, service = pcall(function()
			return game:GetService(name)
		end)
		if found and service then
			table.insert(services, describe(service, 0))
		end
	end
	return { services = services, nodes = count }
end

local function safeTree()
	local built, tree = pcall(buildTree)
	if not built then
		return nil
	end
	local encodable = pcall(function()
		return HttpService:JSONEncode(tree)
	end)
	if not encodable then
		return nil
	end
	return tree
end

local function resolve(path)
	local parts = string.split(path, "/")
	local found, current = pcall(function()
		return game:GetService(parts[1])
	end)
	if not found or not current then
		return nil, "Unknown service " .. tostring(parts[1])
	end
	for index = 2, #parts do
		local child = current:FindFirstChild(parts[index])
		if not child then
			return nil, "Nothing found at " .. table.concat(parts, "/", 1, index)
		end
		current = child
	end
	return current
end

local function numbers(value, expected)
	local list = {}
	for piece in string.gmatch(value, "[^,]+") do
		local number = tonumber((string.gsub(piece, "%s", "")))
		if not number then
			return nil
		end
		table.insert(list, number)
	end
	if #list ~= expected then
		return nil
	end
	return list
end

local function convert(kind, value)
	if kind == "string" then
		return true, value
	elseif kind == "number" then
		local number = tonumber(value)
		if number then
			return true, number
		end
		return false
	elseif kind == "boolean" then
		return true, value == "true"
	elseif kind == "Vector3" then
		local n = numbers(value, 3)
		if n then
			return true, Vector3.new(n[1], n[2], n[3])
		end
		return false
	elseif kind == "Color3" then
		local n = numbers(value, 3)
		if n then
			return true, Color3.fromRGB(n[1], n[2], n[3])
		end
		return false
	elseif kind == "UDim2" then
		local n = numbers(value, 4)
		if n then
			return true, UDim2.new(n[1], n[2], n[3], n[4])
		end
		return false
	elseif kind == "BrickColor" then
		return true, BrickColor.new(value)
	elseif kind == "Enum" then
		local trimmed = (string.gsub(value, "^Enum%.", ""))
		local enumName, itemName = string.match(trimmed, "^([%w_]+)%.([%w_]+)$")
		if not enumName then
			return false
		end
		local found, item = pcall(function()
			return Enum[enumName][itemName]
		end)
		if found and item then
			return true, item
		end
		return false
	end
	return false
end

local function applyProperties(instance, properties)
	local problems = {}
	for _, property in ipairs(properties or {}) do
		local converted, value = convert(property.kind, property.value)
		if not converted then
			table.insert(problems, property.name .. " (bad value)")
		else
			local assigned = pcall(function()
				instance[property.name] = value
			end)
			if not assigned then
				table.insert(problems, property.name .. " (rejected by Studio)")
			end
		end
	end
	return problems
end

local function runOperation(op)
	if op.type == "create" then
		local parent, problem = resolve(op.parent)
		if not parent then
			return false, problem
		end
		local made, instance = pcall(function()
			return Instance.new(op.class)
		end)
		if not made then
			return false, "Studio cannot create a " .. tostring(op.class)
		end
		instance.Name = op.name
		local problems = applyProperties(instance, op.properties)
		local placed = pcall(function()
			instance.Parent = parent
		end)
		if not placed then
			instance:Destroy()
			return false, "Could not place it in " .. op.parent
		end
		if #problems > 0 then
			return false, "Created " .. instance:GetFullName() .. ", but could not set: " .. table.concat(problems, ", ")
		end
		return true, "Created " .. instance:GetFullName(), instance
	elseif op.type == "script" then
		local parent, problem = resolve(op.parent)
		if not parent then
			return false, problem
		end
		local existing = parent:FindFirstChild(op.name)
		if existing and existing.ClassName ~= op.class then
			return false, existing:GetFullName() .. " already exists as a " .. existing.ClassName
		end
		local target = existing
		if not target then
			target = Instance.new(op.class)
			target.Name = op.name
		end
		local written = pcall(function()
			target.Source = op.source
		end)
		if not written then
			if not existing then
				target:Destroy()
			end
			return false, "Studio refused the script source"
		end
		if not existing then
			target.Parent = parent
		end
		return true, (existing and "Updated " or "Created ") .. target:GetFullName(), target
	elseif op.type == "set" then
		local instance, problem = resolve(op.path)
		if not instance then
			return false, problem
		end
		local problems = applyProperties(instance, op.properties)
		if #problems > 0 then
			return false, "Could not set: " .. table.concat(problems, ", ")
		end
		return true, "Updated " .. instance:GetFullName(), instance
	elseif op.type == "destroy" then
		local instance, problem = resolve(op.path)
		if not instance then
			return false, problem
		end
		if instance.Parent == game then
			return false, "Services cannot be removed"
		end
		local name = instance:GetFullName()
		local removed = pcall(function()
			instance.Parent = nil
		end)
		if not removed then
			return false, "Studio would not remove " .. name
		end
		return true, "Removed " .. name, instance
	end
	return false, "Unsupported operation"
end

-- Reads the place back after an operation. A result only counts as verified when Studio really shows the change.
local function verifyOperation(op, instance)
	if op.type == "destroy" then
		return instance.Parent == nil
	end
	if not instance:IsDescendantOf(game) then
		return false
	end
	if op.type == "script" then
		return instance.ClassName == op.class and instance.Source == op.source
	end
	for _, property in ipairs(op.properties or {}) do
		local converted, expected = convert(property.kind, property.value)
		local read, actual = pcall(function()
			return instance[property.name]
		end)
		if not converted or not read then
			return false
		end
		if type(expected) == "number" and type(actual) == "number" then
			if math.abs(actual - expected) > 0.001 then
				return false
			end
		elseif actual ~= expected then
			return false
		end
	end
	return true
end

local function runJob(job)
	if applied[job.id] then
		return
	end
	applied[job.id] = true
	local operations = job.operations or {}
	log("Applying a run with " .. tostring(#operations) .. " operation(s)")

	local recording = nil
	pcall(function()
		recording = ChangeHistoryService:TryBeginRecording("ForgeStudio run")
	end)

	local results = {}
	for index, op in ipairs(operations) do
		local ran, success, message, instance = pcall(runOperation, op)
		if not ran then
			message = "Studio error: " .. tostring(success)
			success = false
		end
		local verified = false
		if success == true and instance then
			local checked, matches = pcall(verifyOperation, op, instance)
			verified = checked and matches == true
		end
		results[index] = { ok = success == true, verified = verified, message = tostring(message) }
		log((success == true and "OK  " or "FAIL  ") .. tostring(message))
	end

	local undoRecorded = false
	if recording then
		undoRecorded = pcall(function()
			ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
		end)
	end

	local payload = {
		action = "report",
		token = token,
		jobId = job.id,
		results = results,
		undoRecorded = undoRecorded,
		tree = safeTree(),
	}
	for attempt = 1, 5 do
		local data, problem, status = request(payload)
		if data then
			log("Results reported to ForgeStudio")
			return
		end
		if status == 401 or status == 404 or status == 409 then
			log("Report rejected: " .. tostring(problem))
			return
		end
		task.wait(attempt * 2)
	end
	log("Could not report results. ForgeStudio will mark this run as failed.")
end

pairButton.MouseButton1Click:Connect(function()
	local code = string.upper((string.gsub(codeBox.Text, "%s", "")))
	if #code ~= 8 then
		setStatus("Enter the 8-character code from your ForgeStudio project.", RED)
		return
	end
	setStatus("Pairing...", GREY)
	local data, problem = request({
		action = "pair",
		code = code,
		pluginVersion = VERSION,
		placeName = game.Name,
		placeId = tostring(game.PlaceId),
	})
	if not data then
		setStatus("Pairing failed: " .. tostring(problem), RED)
		return
	end
	token = data.token
	if persist then
		plugin:SetSetting(tokenKey, token)
	end
	codeBox.Text = ""
	polls = 0
	setStatus("Connected to " .. tostring(data.projectName), GREEN)
	log("Paired with " .. tostring(data.projectName))
	if not persist then
		log("This place is unpublished, so pairing lasts until Studio closes.")
	end
end)

disconnectButton.MouseButton1Click:Connect(function()
	clearToken()
	setStatus("Disconnected. Enter a pairing code to connect again.", GREY)
	log("Disconnected by you")
end)

if token then
	setStatus("Reconnecting...", GREY)
end

task.spawn(function()
	while running do
		if token and not busy then
			busy = true
			polls += 1
			local payload = { action = "poll", token = token }
			if polls % TREE_EVERY == 1 then
				payload.tree = safeTree()
			end
			local data, problem, status = request(payload)
			if data then
				if data.protocol ~= PROTOCOL then
					setStatus("This plugin is out of date. Download the latest one from ForgeStudio.", RED)
				else
					setStatus("Connected to " .. tostring(data.projectName), GREEN)
					if type(data.job) == "table" then
						local finished, crash = pcall(runJob, data.job)
						if not finished then
							log("Run stopped unexpectedly: " .. tostring(crash))
						end
					end
				end
			elseif status == 401 then
				clearToken()
				setStatus("Pairing is no longer valid. Enter a new code.", RED)
			else
				setStatus("Cannot reach ForgeStudio: " .. tostring(problem), RED)
			end
			busy = false
		end
		task.wait(POLL_SECONDS)
	end
end)
