/*
 * Minimal replacement for the AC_NEED_BYTEORDER_H-generated
 * gphoto2-endian.h. Emscripten's libc already provides htoleN/leNtoh and
 * htobeN/beNtoh (see <endian.h>); we only need to add the unaligned "array"
 * variants (htoleNa/leNatoh, htobeNa/beNatoh) that ptp.h/ptp-pack.c expect
 * on top of those.
 */
#ifndef GPHOTO2_ENDIAN_H
#define GPHOTO2_ENDIAN_H

#include <endian.h>
#include <stdint.h>
#include <string.h>

#define GPHOTO2_ENDIAN_DEFINE(N) \
  static inline void htole##N##a(uint8_t *a, uint##N##_t v) { uint##N##_t le = htole##N(v); memcpy(a, &le, sizeof(le)); } \
  static inline uint##N##_t le##N##atoh(const uint8_t *a) { uint##N##_t le; memcpy(&le, a, sizeof(le)); return le##N##toh(le); } \
  static inline void htobe##N##a(uint8_t *a, uint##N##_t v) { uint##N##_t be = htobe##N(v); memcpy(a, &be, sizeof(be)); } \
  static inline uint##N##_t be##N##atoh(const uint8_t *a) { uint##N##_t be; memcpy(&be, a, sizeof(be)); return be##N##toh(be); }

GPHOTO2_ENDIAN_DEFINE(16)
GPHOTO2_ENDIAN_DEFINE(32)
GPHOTO2_ENDIAN_DEFINE(64)

#undef GPHOTO2_ENDIAN_DEFINE

#endif
