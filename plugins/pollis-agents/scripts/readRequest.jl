# Pollis panel requests: runs a request file and writes the list of panels it asks for.
#
#   julia readRequest.jl panels.jl      runs the request file, writes panels.request.toml next to it
#   julia readRequest.jl panels.toml    checks a request written as TOML (the same fields)
#
# A request file is Julia: it calls toolbox once and panel once per panel to write, with loops,
# conditions and variables as the user likes. The create-panel skill writes the panels from the
# resolved list, with no questions asked.
#
#   toolbox(name = "pollis-toolbox-npreg", displayName = "Nonparametric Regression",
#           author = "Ana Silva")
#
#   audience = "students"
#   for (topic, methods) in [
#           "Scatterplot smoothing" => ["LOESS", "Smoothing splines", "Linear regression"],
#           "Kernel density estimation" => ["Gaussian kernel", "Epanechnikov kernel"]]
#       panel(topic = topic, audience = audience, methods = methods,
#             packages = audience == "students" ? ["Loess", "KernelDensity"] : String[],
#             menu = "Model > Nonparametric Regression")
#   end
#
# toolbox: name (pollis-toolbox-...), displayName, and optional description, author, version.
# panel:   topic, methods (1 to 8: the tabs), and optional audience, packages, menu, title, id,
#          notes (anything else the agent should know). menu is a top menu (Toolboxes, Explore,
#          Model, Simulate, Optimise) or a submenu id, then optionally "> " and the title of a
#          submenu to put the panel in; default "Toolboxes > <displayName>".

using TOML

const TOP_MENUS = ("Toolboxes", "Explore", "Model", "Simulate", "Optimise")
const ID_PATTERN = r"^[a-z0-9][a-z0-9-]*$"
const TOOLBOX = Dict{String,Any}()
const PANELS = Dict{String,Any}[]

struct RequestError <: Exception
	message::String
end

fail(message) = throw(RequestError(message))

# Keeps the fields that were given: empty strings and lists are left out.
function fields(pairs...)
	result = Dict{String,Any}()
	for (key, value) in pairs
		if !isempty(value)
			result[key] = value
		end
	end
	return result
end

function strings(name, value)
	list = value isa AbstractString ? [value] : value
	list isa AbstractVector || fail("$name: give a list of strings, for example [\"A\", \"B\"]")
	return [strip(string(item)) for item in list if !isempty(strip(string(item)))]
end

function toolbox(; name::AbstractString, displayName::AbstractString, description::AbstractString = "",
		author::AbstractString = "", version::AbstractString = "1.0.0")
	isempty(TOOLBOX) || fail("toolbox(...) is called more than once: a request makes one toolbox")
	occursin(ID_PATTERN, name) || fail("toolbox name \"$name\": use lower case letters, digits and hyphens")
	isempty(strip(displayName)) && fail("toolbox displayName is empty")
	occursin(r"^\d+\.\d+\.\d+$", version) || fail("toolbox version \"$version\": write it as 1.0.0")
	merge!(TOOLBOX, fields("name" => name, "displayName" => strip(displayName),
		"description" => strip(description), "author" => strip(author), "version" => version))
	return nothing
end

function panel(; topic::AbstractString, methods, audience::AbstractString = "", packages = String[],
		menu::AbstractString = "", title::AbstractString = "", id::AbstractString = "",
		notes::AbstractString = "")
	isempty(strip(topic)) && fail("a panel has an empty topic")
	methodList = strings("methods of \"$topic\"", methods)
	1 <= length(methodList) <= 8 || fail("\"$topic\" has $(length(methodList)) methods: give 1 to 8 (they become the tabs)")
	isempty(id) || occursin(ID_PATTERN, id) || fail("panel id \"$id\": use lower case letters, digits and hyphens")
	path = isempty(strip(menu)) ? String[] : strip.(split(menu, r"[>›]"))
	length(path) <= 2 && all(!isempty, path) || fail("menu \"$menu\" of \"$topic\": write a menu, or a menu > a submenu title")
	isempty(path) || first(path) in TOP_MENUS || occursin(ID_PATTERN, first(path)) ||
		fail("menu \"$menu\" of \"$topic\": start with $(join(TOP_MENUS, ", ")) or a submenu id")
	push!(PANELS, fields("topic" => strip(topic), "methods" => methodList, "audience" => strip(audience),
		"packages" => strings("packages of \"$topic\"", packages), "menu" => join(path, " > "),
		"title" => strip(title), "id" => id, "notes" => strip(notes)))
	return nothing
end

# Calls toolbox and panel with the tables of a TOML request.
function readToml(file)
	data = TOML.parsefile(file)
	call(f, table, what) = try
		f(; (Symbol(key) => value for (key, value) in table)...)
	catch error
		error isa RequestError && rethrow()
		fail("$what: $(sprint(showerror, error))")
	end
	haskey(data, "toolbox") && call(toolbox, data["toolbox"], "[toolbox]")
	for (index, table) in enumerate(get(data, "panel", []))
		call(panel, table, "[[panel]] number $index")
	end
end

function main(args)
	length(args) == 1 || fail("usage: julia readRequest.jl <request.jl or request.toml>")
	file = abspath(args[1])
	isfile(file) || fail("no file $file")
	if endswith(file, ".toml")
		readToml(file)
	else
		try
			Base.include(Main, file)
		catch error
			error isa LoadError && error.error isa RequestError && throw(error.error)
			rethrow()
		end
	end
	isempty(TOOLBOX) && fail("the request has no toolbox(...): name the toolbox the panels go in")
	isempty(PANELS) && fail("the request has no panel(...)")
	topics = [panel["topic"] for panel in PANELS]
	for topic in unique(topics)
		count(==(topic), topics) > 1 && fail("the topic \"$topic\" is requested more than once")
	end
	for panel in PANELS
		haskey(panel, "menu") || (panel["menu"] = "Toolboxes > " * TOOLBOX["displayName"])
	end
	request = Dict("toolbox" => TOOLBOX, "panel" => PANELS)
	output = endswith(file, ".toml") ? file : string(splitext(file)[1], ".request.toml")
	if output != file
		open(output, "w") do io
			println(io, "# Written by readRequest.jl from ", basename(file), ": the panels to write.")
			TOML.print(io, request; sorted = true)
		end
	end
	println("Toolbox ", TOOLBOX["name"], " (", TOOLBOX["displayName"], "), ", length(PANELS), " panel(s):")
	for panel in PANELS
		println("  ", panel["topic"], ": ", join(panel["methods"], ", "), "  [", panel["menu"], "]")
	end
	output != file && println("Written: ", output)
end

try
	main(ARGS)
catch error
	error isa RequestError || rethrow()
	println(stderr, "Request error: ", error.message)
	exit(1)
end
