/* Flat accessor FFI over libmtp's pointer-linked structs; all logic lives in
 * TypeScript under src/. */
#include <emscripten.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include "libmtp.h"
#include "ptp.h"

static int g_initialized = 0;
static LIBMTP_raw_device_t *g_raw_devices = NULL;
static int g_num_raw_devices = 0;

EMSCRIPTEN_KEEPALIVE
void mtp_set_debug_level(int level) {
  LIBMTP_Set_Debug(level);
}

static void ensure_initialized(void) {
  if (g_initialized) {
    return;
  }
  LIBMTP_Init();
  g_initialized = 1;
}

/* Returns the number of raw devices found, or a negative LIBMTP_error_number_t. */
EMSCRIPTEN_KEEPALIVE
int mtp_detect_raw_devices(void) {
  ensure_initialized();
  free(g_raw_devices);
  g_raw_devices = NULL;
  g_num_raw_devices = 0;
  LIBMTP_error_number_t err = LIBMTP_Detect_Raw_Devices(&g_raw_devices, &g_num_raw_devices);
  if (err != LIBMTP_ERROR_NONE) {
    return -(int)err - 1;
  }
  return g_num_raw_devices;
}

/* Uncached because LIBMTP_Get_Files_And_Folders refuses cached devices. Returns
 * NULL on failure - see webusb_get_last_error(). */
EMSCRIPTEN_KEEPALIVE
LIBMTP_mtpdevice_t *mtp_open_raw_device(int index) {
  return LIBMTP_Open_Raw_Device_Uncached(&g_raw_devices[index]);
}

EMSCRIPTEN_KEEPALIVE
void mtp_release_device(LIBMTP_mtpdevice_t *device) {
  LIBMTP_Release_Device(device);
}

/* Both return a malloc'd string to be freed via mtp_free_string. */
EMSCRIPTEN_KEEPALIVE
char *mtp_friendlyname(LIBMTP_mtpdevice_t *device) {
  return LIBMTP_Get_Friendlyname(device);
}

EMSCRIPTEN_KEEPALIVE
char *mtp_modelname(LIBMTP_mtpdevice_t *device) {
  return LIBMTP_Get_Modelname(device);
}

/* Returns 0 on success, matching LIBMTP_Get_Storage's own contract. */
EMSCRIPTEN_KEEPALIVE
int mtp_get_storage(LIBMTP_mtpdevice_t *device) {
  return LIBMTP_Get_Storage(device, LIBMTP_STORAGE_SORTBY_NOTSORTED);
}

EMSCRIPTEN_KEEPALIVE
LIBMTP_devicestorage_t *mtp_storage_first(LIBMTP_mtpdevice_t *device) {
  return device->storage;
}

EMSCRIPTEN_KEEPALIVE
LIBMTP_devicestorage_t *mtp_storage_next(LIBMTP_devicestorage_t *storage) {
  return storage->next;
}

EMSCRIPTEN_KEEPALIVE
unsigned int mtp_storage_id(LIBMTP_devicestorage_t *storage) {
  return storage->id;
}

EMSCRIPTEN_KEEPALIVE
const char *mtp_storage_description(LIBMTP_devicestorage_t *storage) {
  return storage->StorageDescription;
}

EMSCRIPTEN_KEEPALIVE
LIBMTP_file_t *mtp_get_files_and_folders(LIBMTP_mtpdevice_t *device, unsigned int storage_id, unsigned int parent_id) {
  return LIBMTP_Get_Files_And_Folders(device, storage_id, parent_id);
}

EMSCRIPTEN_KEEPALIVE
LIBMTP_file_t *mtp_file_next(LIBMTP_file_t *file) {
  return file->next;
}

EMSCRIPTEN_KEEPALIVE
unsigned int mtp_file_item_id(LIBMTP_file_t *file) {
  return file->item_id;
}

EMSCRIPTEN_KEEPALIVE
int mtp_file_is_folder(LIBMTP_file_t *file) {
  return file->filetype == LIBMTP_FILETYPE_FOLDER;
}

EMSCRIPTEN_KEEPALIVE
unsigned int mtp_file_size_lo(LIBMTP_file_t *file) {
  return (unsigned int)(file->filesize & 0xffffffffu);
}

EMSCRIPTEN_KEEPALIVE
unsigned int mtp_file_size_hi(LIBMTP_file_t *file) {
  return (unsigned int)(file->filesize >> 32);
}

/* Returns seconds since the Unix epoch. */
EMSCRIPTEN_KEEPALIVE
unsigned int mtp_file_modification_time(LIBMTP_file_t *file) {
  return (unsigned int)file->modificationdate;
}

EMSCRIPTEN_KEEPALIVE
const char *mtp_file_name(LIBMTP_file_t *file) {
  return file->filename;
}

EMSCRIPTEN_KEEPALIVE
void mtp_file_destroy(LIBMTP_file_t *file) {
  LIBMTP_destroy_file_t(file);
}

EMSCRIPTEN_KEEPALIVE
void mtp_free_string(char *ptr) {
  free(ptr);
}

EMSCRIPTEN_KEEPALIVE
void mtp_free_file_buffer(unsigned char *buffer) {
  free(buffer);
}

/* Consults the device's cached DeviceInfo operation list; no device I/O. */
EMSCRIPTEN_KEEPALIVE
int mtp_device_supports_operation(LIBMTP_mtpdevice_t *device, unsigned int operation_code) {
  return ptp_operation_issupported((PTPParams *)device->params, (uint16_t)operation_code);
}

/* Fills out (uint16_t slots) with the unique vendor ids from libmtp's static
 * device table - the same table its detection matches by when a device does
 * not advertise the MTP interface class. Returns the number written, or -1
 * when capacity is too small. */
EMSCRIPTEN_KEEPALIVE
int mtp_supported_vendor_ids(unsigned short *out, int capacity) {
  LIBMTP_device_entry_t *devices = NULL;
  int num_devices = 0;
  if (LIBMTP_Get_Supported_Devices_List(&devices, &num_devices) != 0) {
    return 0;
  }
  int count = 0;
  for (int i = 0; i < num_devices; i++) {
    unsigned short vendor_id = devices[i].vendor_id;
    int seen = 0;
    for (int j = 0; j < count && !seen; j++) {
      seen = out[j] == vendor_id;
    }
    if (seen) {
      continue;
    }
    if (count == capacity) {
      return -1;
    }
    out[count++] = vendor_id;
  }
  return count;
}

/* *out_data is NULL only for an empty range (at/past end-of-file). Returns 0
 * on success. The offset is split because the PTP op libmtp sends is 32-bit.
 * Free *out_data with mtp_free_file_buffer(). */
EMSCRIPTEN_KEEPALIVE
int mtp_read_file_range(LIBMTP_mtpdevice_t *device, unsigned int file_id,
                        unsigned int offset_lo, unsigned int offset_hi,
                        unsigned int length, unsigned char **out_data, unsigned int *out_length) {
  *out_data = NULL;
  *out_length = 0;
  uint64_t offset = ((uint64_t)offset_hi << 32) | offset_lo;
  int result = LIBMTP_GetPartialObject(device, file_id, offset, length, out_data, out_length);
  if (result != 0) {
    free(*out_data);
    *out_data = NULL;
    *out_length = 0;
  }
  return result;
}

/* Implemented in src/webusb-async.lib.ts; suspends through JSPI while the
 * stream consumer takes the chunk (backpressure). Returns 0 on success. */
extern uint32_t js_stream_push(const unsigned char *data, uint32_t length);

static uint16_t write_to_js_stream(void *params, void *priv, uint32_t sendlen, unsigned char *data, uint32_t *putlen) {
  (void)params;
  (void)priv;
  if (js_stream_push(data, sendlen) != 0) {
    return LIBMTP_HANDLER_RETURN_ERROR;
  }
  *putlen = sendlen;
  return LIBMTP_HANDLER_RETURN_OK;
}

/* Streams the whole object to the session-registered js_stream_push sink,
 * chunk by chunk. Returns 0 on success. */
EMSCRIPTEN_KEEPALIVE
int mtp_read_file_stream(LIBMTP_mtpdevice_t *device, unsigned int file_id) {
  return LIBMTP_Get_File_To_Handler(device, file_id, write_to_js_stream, NULL, NULL, NULL);
}

/* Extensions with no PTP object format (gpx, fit, ...) stay UNKNOWN, which
 * libmtp sends as "undefined". */
static const struct {
  const char *extension;
  LIBMTP_filetype_t filetype;
} FILETYPE_BY_EXTENSION[] = {
  {"txt", LIBMTP_FILETYPE_TEXT},   {"xml", LIBMTP_FILETYPE_XML},
  {"html", LIBMTP_FILETYPE_HTML},  {"wav", LIBMTP_FILETYPE_WAV},
  {"mp3", LIBMTP_FILETYPE_MP3},    {"m4a", LIBMTP_FILETYPE_M4A},
  {"flac", LIBMTP_FILETYPE_FLAC},  {"aac", LIBMTP_FILETYPE_AAC},
  {"mp4", LIBMTP_FILETYPE_MP4},    {"mpeg", LIBMTP_FILETYPE_MPEG},
  {"mpg", LIBMTP_FILETYPE_MPEG},   {"avi", LIBMTP_FILETYPE_AVI},
  {"wmv", LIBMTP_FILETYPE_WMV},    {"asf", LIBMTP_FILETYPE_ASF},
  {"jpg", LIBMTP_FILETYPE_JPEG},   {"jpeg", LIBMTP_FILETYPE_JPEG},
  {"png", LIBMTP_FILETYPE_PNG},    {"gif", LIBMTP_FILETYPE_GIF},
  {"bmp", LIBMTP_FILETYPE_BMP},    {"tif", LIBMTP_FILETYPE_TIFF},
  {"tiff", LIBMTP_FILETYPE_TIFF},  {"jp2", LIBMTP_FILETYPE_JP2},
  {"doc", LIBMTP_FILETYPE_DOC},    {"xls", LIBMTP_FILETYPE_XLS},
  {"ppt", LIBMTP_FILETYPE_PPT},
};

static LIBMTP_filetype_t filetype_for_name(const char *name) {
  const char *dot = strrchr(name, '.');
  if (!dot) {
    return LIBMTP_FILETYPE_UNKNOWN;
  }
  const char *extension = dot + 1;
  for (size_t i = 0; i < sizeof(FILETYPE_BY_EXTENSION) / sizeof(FILETYPE_BY_EXTENSION[0]); i++) {
    if (strcasecmp(extension, FILETYPE_BY_EXTENSION[i].extension) == 0) {
      return FILETYPE_BY_EXTENSION[i].filetype;
    }
  }
  return LIBMTP_FILETYPE_UNKNOWN;
}

/* Implemented in src/webusb-async.lib.ts; suspends through JSPI while the
 * stream reader yields chunks. Returns the number of bytes filled. */
extern uint32_t js_stream_pull(unsigned char *buffer, uint32_t wantlen);

/* libmtp's send loop can spin on a silent short read, so an under-fill must
 * abort the transfer instead. */
static uint16_t read_from_js_stream(void *params, void *priv, uint32_t wantlen, unsigned char *data, uint32_t *gotlen) {
  (void)params;
  (void)priv;
  *gotlen = js_stream_pull(data, wantlen);
  if (*gotlen != wantlen) {
    return LIBMTP_HANDLER_RETURN_ERROR;
  }
  return LIBMTP_HANDLER_RETURN_OK;
}

/* Streams a new file from js_stream_pull chunks; size_lo/size_hi declare the
 * exact byte count up front, as SendObjectInfo requires. Returns the new item
 * id, or 0 on failure. */
EMSCRIPTEN_KEEPALIVE
uint32_t mtp_send_file_stream(LIBMTP_mtpdevice_t *device, unsigned int storage_id, unsigned int parent_id,
                              const char *name, unsigned int size_lo, unsigned int size_hi) {
  LIBMTP_file_t *file = LIBMTP_new_file_t();
  char *owned_name = strdup(name);
  if (!file || !owned_name) {
    free(owned_name);
    if (file) {
      LIBMTP_destroy_file_t(file);
    }
    return 0;
  }
  file->storage_id = storage_id;
  file->parent_id = parent_id;
  file->filename = owned_name;
  file->filesize = ((uint64_t)size_hi << 32) | size_lo;
  file->filetype = filetype_for_name(name);
  int result = LIBMTP_Send_File_From_Handler(device, read_from_js_stream, NULL, file, NULL, NULL);
  uint32_t item_id = (result == 0) ? file->item_id : 0;
  LIBMTP_destroy_file_t(file);
  return item_id;
}

/* Both return 0 on failure: the new folder's id / a libmtp status. */
EMSCRIPTEN_KEEPALIVE
uint32_t mtp_create_folder(LIBMTP_mtpdevice_t *device, unsigned int storage_id, unsigned int parent_id, const char *name) {
  return LIBMTP_Create_Folder(device, (char *)name, parent_id, storage_id);
}

EMSCRIPTEN_KEEPALIVE
int mtp_delete_object(LIBMTP_mtpdevice_t *device, unsigned int object_id) {
  return LIBMTP_Delete_Object(device, object_id);
}
