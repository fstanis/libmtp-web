#ifndef _LIBMTP_CONFIG_H
#define _LIBMTP_CONFIG_H 1

/* ptp.c/ptp-pack.c use INT_MAX without including it themselves - normally
 * pulled in transitively via some other system header on Linux/macOS. */
#include <limits.h>

/* We provide our own WebUSB-backed implementation of the libusb-1.0 API,
 * so libmtp is built against the real libusb1-glue.c backend. */
#define HAVE_LIBUSB1 1

/* Emscripten's libc already provides strndup(). */
#define HAVE_STRNDUP 1

#define HAVE_UNISTD_H 1

/* No iconv in this build: ptp-pack.c/unicode.c fall back to a plain
 * ASCII-safe transcoding path when HAVE_ICONV is undefined, which is
 * sufficient for this proof of concept. */
/* #undef HAVE_ICONV */
/* #undef HAVE_LANGINFO_H */

/* No libxml2 in this build. */
/* #undef HAVE_LIBXML2 */

#define VERSION "1.1.23-wasm"
#define PACKAGE_VERSION "1.1.23-wasm"

#endif
