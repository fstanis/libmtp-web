set_project("libmtp-web")
set_version("0.1.0")

add_rules("mode.debug", "mode.release")
set_defaultmode("release")

set_toolchains("emcc")
set_plat("wasm")
set_arch("wasm32")

package("libmtp")
    set_urls("https://github.com/libmtp/libmtp/archive/refs/tags/v$(version).tar.gz")
    add_versions("1.1.23", "93ba3f860805f793ffaec3886ed5a2c1ea0a2e0407974c1d1b732d4d38ce34bc")

    local libgphoto2_commit = "5672d510447bed26aa4c5d646665e768281bc680"
    local libusb_tag = "v1.0.30"

    on_install(function (package)
        os.cd("src")

        io.writefile("libmtp.h", (io.readfile("libmtp.h.in"):gsub("@VERSION@", package:version_str())))
        os.cp(path.join(os.scriptdir(), "src/wasm/config/config.h"), "config.h")
        os.cp(path.join(os.scriptdir(), "src/wasm/config/gphoto2-endian.h"), "gphoto2-endian.h")

        local function fetch_verified(url, dest, expected_sha256)
            os.vrunv("curl", {"-sL", "-o", dest, url})
            local actual = os.iorunv("shasum", {"-a", "256", dest}):trim():split("%s+")[1]
            assert(actual == expected_sha256, "checksum mismatch for %s: expected %s, got %s", dest, expected_sha256, actual)
        end

        fetch_verified(
            "https://raw.githubusercontent.com/gphoto/libgphoto2/" .. libgphoto2_commit .. "/camlibs/ptp2/array.h",
            "array.h", "3c4222b412fd234256a9bb636a6a1dada1e70f94037064924f01fc8f84a679fe")
        fetch_verified(
            "https://raw.githubusercontent.com/gphoto/libgphoto2/" .. libgphoto2_commit .. "/libgphoto2_port/libgphoto2_port/compiletime-assert.h",
            "compiletime-assert.h", "69266753ccfe8de30416f0c8b890809ea09d930f7340c2a60f9a6b9c1d56b06b")
        os.mkdir("include")
        fetch_verified(
            "https://raw.githubusercontent.com/libusb/libusb/" .. libusb_tag .. "/libusb/libusb.h",
            "include/libusb.h", "a61260ab145b051b86df2b0575956f01810190abe2c7df6aca831c33bdc8082c")

        local sources = {
            "libmtp.c", "libusb1-glue.c", "ptp.c", "unicode.c", "util.c",
        }
        local cflags = {
            "-c", "-O2",
            "-I.", "-Iinclude",
            "-Wno-unused-parameter", "-Wno-sign-compare",
        }

        local objs = {}
        for _, src in ipairs(sources) do
            local obj = src .. ".o"
            os.vrunv("emcc", table.join(cflags, {src, "-o", obj}))
            table.insert(objs, obj)
        end
        os.vrunv("emar", table.join({"rcs", "libmtp.a"}, objs))

        os.cp("libmtp.a", package:installdir("lib"))
        os.cp("*.h", package:installdir("include"))
        os.cp("include/*.h", package:installdir("include"))
    end)

    on_test(function (package)
        assert(os.isfile(path.join(package:installdir("lib"), "libmtp.a")))
    end)
package_end()

add_requires("libmtp")

-- emcc's --js-library must be a plain script, so src/webusb-async.lib.ts is
-- type-stripped without bundling before the wasm target links.
local generated_dir = path.join(os.projectdir(), "build", "generated")
local jslib_file = path.join(generated_dir, "webusb-async.lib.js")

target("mtpwasm")
    set_kind("binary")
    set_filename("mtp.js")

    add_packages("libmtp")

    add_files("src/wasm/webusb_backend.c")
    add_files("src/wasm/mtp_accessors.c")

    add_cflags("-Wno-unused-parameter", "-Wno-sign-compare", {force = true})

    before_build(function (target)
        os.mkdir(generated_dir)
        os.vrunv("npx", {
            "esbuild", path.join(os.projectdir(), "src/webusb-async.lib.ts"),
            "--outfile=" .. jslib_file,
            "--target=esnext", "--platform=neutral", "--format=iife", "--bundle=false",
        }, {curdir = os.projectdir()})
    end)

    local emflags = {
        "-sASYNCIFY=2",
        "-sALLOW_MEMORY_GROWTH=1",
        "-sSTACK_SIZE=1048576",
        "-sMODULARIZE=1",
        "-sEXPORT_ES6=1",
        "-sEXPORT_NAME=createMtpModule",
        "-sENVIRONMENT=web",
        "-sEXPORTED_RUNTIME_METHODS=[\"ccall\",\"UTF8ToString\",\"HEAPU8\",\"HEAP32\"]",
        "-sEXPORTED_FUNCTIONS=[" ..
            "\"_malloc\",\"_free\"," ..
            "\"_mtp_set_debug_level\",\"_mtp_detect_raw_devices\"," ..
            "\"_mtp_open_raw_device\",\"_mtp_release_device\"," ..
            "\"_mtp_friendlyname\",\"_mtp_modelname\",\"_mtp_get_storage\"," ..
            "\"_mtp_storage_first\",\"_mtp_storage_next\",\"_mtp_storage_id\",\"_mtp_storage_description\"," ..
            "\"_mtp_get_files_and_folders\",\"_mtp_file_next\",\"_mtp_file_item_id\"," ..
            "\"_mtp_file_is_folder\",\"_mtp_file_size_lo\",\"_mtp_file_size_hi\",\"_mtp_file_name\"," ..
            "\"_mtp_file_modification_time\"," ..
            "\"_mtp_free_file_buffer\"," ..
            "\"_mtp_read_file_range\",\"_mtp_read_file_stream\",\"_mtp_device_supports_operation\"," ..
            "\"_mtp_supported_vendor_ids\"," ..
            "\"_mtp_send_file_stream\",\"_mtp_create_folder\",\"_mtp_delete_object\"," ..
            "\"_mtp_file_destroy\",\"_mtp_free_string\",\"_webusb_get_last_error\"" ..
        "]",
        "--js-library=" .. jslib_file,
        "--no-entry",
    }
    add_ldflags(emflags, {force = true})

    after_build(function (target)
        os.mkdir(generated_dir)
        os.trycp(path.join(target:targetdir(), "mtp.js"), generated_dir)
        local outdir = path.join(os.projectdir(), "dist")
        os.mkdir(outdir)
        os.trycp(path.join(target:targetdir(), "mtp.wasm"), outdir)
    end)
