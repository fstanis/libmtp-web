/*
 * The libusb-1.0 API surface libmtp's libusb1-glue.c calls, backed by WebUSB:
 * compiled against the genuine upstream <libusb.h> so libmtp stays unmodified.
 * Descriptor structs are marshaled here because they need real C layout.
 */
#include <libusb.h>
#include <stdlib.h>
#include <string.h>

/* Implemented in src/webusb-async.lib.ts. */
extern int js_usb_get_last_error(char *out, int outlen);
extern int js_usb_refresh_devices(void);
extern int js_usb_device_id_at(int index);
extern int js_usb_desc_int(int id, int field);
extern int js_usb_bus_number(int id);
extern int js_usb_device_address(int id);
extern int js_usb_num_interfaces(int id, int configIndex);
extern int js_usb_config_value(int id, int configIndex);
extern int js_usb_active_config_index(int id);
extern int js_usb_num_altsettings(int id, int configIndex, int ifaceIndex);
extern int js_usb_iface_field(int id, int configIndex, int ifaceIndex, int altIndex, int field);
extern int js_usb_num_endpoints(int id, int configIndex, int ifaceIndex, int altIndex);
extern int js_usb_ep_field(int id, int configIndex, int ifaceIndex, int altIndex, int epIndex, int field);
extern int js_usb_get_string(int id, int index, char *out, int outlen);
extern int js_usb_open(int id);
extern void js_usb_close(int id);
extern int js_usb_set_configuration(int id, int configValue);
extern int js_usb_claim_interface(int id, int ifaceNumber);
extern int js_usb_release_interface(int id, int ifaceNumber);
extern int js_usb_reset_device(int id);
extern int js_usb_clear_halt(int id, int endpointAddress);
extern int js_usb_bulk_transfer(int id, int endpointAddress, uint8_t *data, int length, int timeoutMs);
extern int js_usb_control_transfer(int id, int bmRequestType, int bRequest, int wValue, int wIndex,
                                    uint8_t *data, int wLength, int timeoutMs);

/* libusb.h only forward-declares these; the bodies are ours. */

struct libusb_context {
  int unused;
};

struct libusb_device {
  int id;      /* stable id assigned to the underlying WebUSB device */
  int refcnt;
};

struct libusb_device_handle {
  int id;      /* same id as the libusb_device it was opened from */
};

static libusb_context g_default_context;

int libusb_init(libusb_context **ctx) {
  if (ctx) {
    *ctx = &g_default_context;
  }
  return LIBUSB_SUCCESS;
}

void libusb_exit(libusb_context *ctx) { (void)ctx; }

int libusb_set_option(libusb_context *ctx, enum libusb_option option, ...) {
  (void)ctx; (void)option;
  return LIBUSB_SUCCESS;
}

ssize_t libusb_get_device_list(libusb_context *ctx, libusb_device ***list) {
  (void)ctx;
  int count = js_usb_refresh_devices();
  if (count < 0) {
    count = 0;
  }
  libusb_device **arr = calloc(count > 0 ? count : 1, sizeof(libusb_device *));
  for (int i = 0; i < count; i++) {
    int id = js_usb_device_id_at(i);
    libusb_device *dev = malloc(sizeof(*dev));
    dev->id = id;
    dev->refcnt = 1;
    arr[i] = dev;
  }
  *list = arr;
  return count;
}

void libusb_free_device_list(libusb_device **list, int unref_devices) {
  if (!list) {
    return;
  }
  if (unref_devices) {
    for (int i = 0; list[i]; i++) {
      if (--list[i]->refcnt <= 0) {
        free(list[i]);
      }
    }
  }
  free(list);
}

int libusb_get_device_descriptor(libusb_device *dev, struct libusb_device_descriptor *desc) {
  memset(desc, 0, sizeof(*desc));
  desc->bLength = 18;
  desc->bDescriptorType = LIBUSB_DT_DEVICE;
  desc->bcdUSB = js_usb_desc_int(dev->id, 6);
  desc->bDeviceClass = js_usb_desc_int(dev->id, 0);
  desc->bDeviceSubClass = js_usb_desc_int(dev->id, 1);
  desc->bDeviceProtocol = js_usb_desc_int(dev->id, 2);
  desc->bMaxPacketSize0 = 64;
  desc->idVendor = js_usb_desc_int(dev->id, 3);
  desc->idProduct = js_usb_desc_int(dev->id, 4);
  desc->bcdDevice = js_usb_desc_int(dev->id, 5);
  desc->iManufacturer = js_usb_desc_int(dev->id, 8) ? 1 : 0;
  desc->iProduct = js_usb_desc_int(dev->id, 9) ? 2 : 0;
  desc->iSerialNumber = js_usb_desc_int(dev->id, 10) ? 3 : 0;
  desc->bNumConfigurations = js_usb_desc_int(dev->id, 7);
  if (desc->bNumConfigurations < 1) {
    desc->bNumConfigurations = 1;
  }
  return LIBUSB_SUCCESS;
}

static struct libusb_config_descriptor *build_config_descriptor(int id, int configIndex) {
  int num_ifaces = js_usb_num_interfaces(id, configIndex);
  if (num_ifaces < 0) {
    return NULL;
  }

  struct libusb_config_descriptor *cfg = calloc(1, sizeof(*cfg));
  cfg->bLength = 9;
  cfg->bDescriptorType = LIBUSB_DT_CONFIG;
  cfg->bConfigurationValue = (uint8_t)js_usb_config_value(id, configIndex);
  cfg->bNumInterfaces = (uint8_t)num_ifaces;

  struct libusb_interface *ifaces = calloc(num_ifaces > 0 ? num_ifaces : 1, sizeof(*ifaces));
  for (int i = 0; i < num_ifaces; i++) {
    int num_alt = js_usb_num_altsettings(id, configIndex, i);
    if (num_alt < 0) {
      num_alt = 0;
    }
    struct libusb_interface_descriptor *alts = calloc(num_alt > 0 ? num_alt : 1, sizeof(*alts));
    for (int a = 0; a < num_alt; a++) {
      int num_ep = js_usb_num_endpoints(id, configIndex, i, a);
      if (num_ep < 0) {
        num_ep = 0;
      }
      struct libusb_endpoint_descriptor *eps = calloc(num_ep > 0 ? num_ep : 1, sizeof(*eps));
      for (int e = 0; e < num_ep; e++) {
        eps[e].bLength = 7;
        eps[e].bDescriptorType = LIBUSB_DT_ENDPOINT;
        eps[e].bEndpointAddress = (uint8_t)js_usb_ep_field(id, configIndex, i, a, e, 0);
        eps[e].bmAttributes = (uint8_t)js_usb_ep_field(id, configIndex, i, a, e, 1);
        eps[e].wMaxPacketSize = (uint16_t)js_usb_ep_field(id, configIndex, i, a, e, 2);
      }
      alts[a].bLength = 9;
      alts[a].bDescriptorType = LIBUSB_DT_INTERFACE;
      alts[a].bInterfaceNumber = (uint8_t)js_usb_iface_field(id, configIndex, i, a, 0);
      alts[a].bAlternateSetting = (uint8_t)js_usb_iface_field(id, configIndex, i, a, 1);
      alts[a].bNumEndpoints = (uint8_t)num_ep;
      alts[a].bInterfaceClass = (uint8_t)js_usb_iface_field(id, configIndex, i, a, 2);
      alts[a].bInterfaceSubClass = (uint8_t)js_usb_iface_field(id, configIndex, i, a, 3);
      alts[a].bInterfaceProtocol = (uint8_t)js_usb_iface_field(id, configIndex, i, a, 4);
      alts[a].endpoint = eps;
    }
    ifaces[i].altsetting = alts;
    ifaces[i].num_altsetting = num_alt;
  }
  cfg->interface = ifaces;
  return cfg;
}

int libusb_get_config_descriptor(libusb_device *dev, uint8_t config_index, struct libusb_config_descriptor **config) {
  struct libusb_config_descriptor *cfg = build_config_descriptor(dev->id, config_index);
  if (!cfg) {
    return LIBUSB_ERROR_NOT_FOUND;
  }
  *config = cfg;
  return LIBUSB_SUCCESS;
}

int libusb_get_active_config_descriptor(libusb_device *dev, struct libusb_config_descriptor **config) {
  int idx = js_usb_active_config_index(dev->id);
  if (idx < 0) {
    idx = 0;
  }
  struct libusb_config_descriptor *cfg = build_config_descriptor(dev->id, idx);
  if (!cfg) {
    return LIBUSB_ERROR_NOT_FOUND;
  }
  *config = cfg;
  return LIBUSB_SUCCESS;
}

void libusb_free_config_descriptor(struct libusb_config_descriptor *config) {
  if (!config) {
    return;
  }
  for (int i = 0; i < config->bNumInterfaces; i++) {
    const struct libusb_interface *iface = &config->interface[i];
    for (int a = 0; a < iface->num_altsetting; a++) {
      free((void *)iface->altsetting[a].endpoint);
    }
    free((void *)iface->altsetting);
  }
  free((void *)config->interface);
  free(config);
}

uint8_t libusb_get_bus_number(libusb_device *dev) { return (uint8_t)js_usb_bus_number(dev->id); }
uint8_t libusb_get_device_address(libusb_device *dev) { return (uint8_t)js_usb_device_address(dev->id); }

libusb_device *libusb_get_device(libusb_device_handle *handle) {
  libusb_device *dev = malloc(sizeof(*dev));
  dev->id = handle->id;
  dev->refcnt = 1;
  return dev;
}

int libusb_open(libusb_device *dev, libusb_device_handle **handle) {
  int rc = js_usb_open(dev->id);
  if (rc != 0) {
    return rc;
  }
  libusb_device_handle *h = malloc(sizeof(*h));
  h->id = dev->id;
  *handle = h;
  return LIBUSB_SUCCESS;
}

void libusb_close(libusb_device_handle *handle) {
  if (!handle) {
    return;
  }
  js_usb_close(handle->id);
  free(handle);
}

int libusb_set_configuration(libusb_device_handle *handle, int configuration) {
  return js_usb_set_configuration(handle->id, configuration);
}

int libusb_claim_interface(libusb_device_handle *handle, int interface_number) {
  return js_usb_claim_interface(handle->id, interface_number);
}

int libusb_release_interface(libusb_device_handle *handle, int interface_number) {
  return js_usb_release_interface(handle->id, interface_number);
}

int libusb_reset_device(libusb_device_handle *handle) {
  return js_usb_reset_device(handle->id);
}

int libusb_clear_halt(libusb_device_handle *handle, unsigned char endpoint) {
  return js_usb_clear_halt(handle->id, endpoint);
}

int libusb_kernel_driver_active(libusb_device_handle *handle, int interface_number) {
  (void)handle; (void)interface_number;
  return 0; /* WebUSB never has a kernel driver attached to hand off. */
}

int libusb_detach_kernel_driver(libusb_device_handle *handle, int interface_number) {
  (void)handle; (void)interface_number;
  return LIBUSB_ERROR_NOT_SUPPORTED;
}

int libusb_bulk_transfer(libusb_device_handle *handle, unsigned char endpoint, unsigned char *data,
                          int length, int *actual_length, unsigned int timeout) {
  int rc = js_usb_bulk_transfer(handle->id, endpoint, data, length, (int)timeout);
  if (rc < 0) {
    if (actual_length) {
      *actual_length = 0;
    }
    return rc;
  }
  if (actual_length) {
    *actual_length = rc;
  }
  return LIBUSB_SUCCESS;
}

int libusb_control_transfer(libusb_device_handle *handle, uint8_t bmRequestType, uint8_t bRequest,
                             uint16_t wValue, uint16_t wIndex, unsigned char *data, uint16_t wLength,
                             unsigned int timeout) {
  return js_usb_control_transfer(handle->id, bmRequestType, bRequest, wValue, wIndex, data, wLength, (int)timeout);
}

int libusb_get_string_descriptor_ascii(libusb_device_handle *handle, uint8_t desc_index,
                                        unsigned char *data, int length) {
  return js_usb_get_string(handle->id, desc_index, (char *)data, length);
}

/* libusb1-glue.c references the async transfer API; unused here, stubbed. */

struct libusb_transfer *libusb_alloc_transfer(int iso_packets) {
  (void)iso_packets;
  return calloc(1, sizeof(struct libusb_transfer));
}

void libusb_free_transfer(struct libusb_transfer *transfer) { free(transfer); }

int libusb_submit_transfer(struct libusb_transfer *transfer) {
  (void)transfer;
  return LIBUSB_ERROR_NOT_SUPPORTED;
}

int libusb_cancel_transfer(struct libusb_transfer *transfer) {
  (void)transfer;
  return LIBUSB_ERROR_NOT_FOUND;
}

int libusb_handle_events_timeout_completed(libusb_context *ctx, struct timeval *tv, int *completed) {
  (void)ctx; (void)tv; (void)completed;
  return LIBUSB_ERROR_NOT_SUPPORTED;
}

/* Not part of libusb: surfaces the last WebUSB error to JS. */

const char *webusb_get_last_error(void) {
  static char buf[512];
  int n = js_usb_get_last_error(buf, sizeof(buf));
  if (n <= 0) {
    return NULL;
  }
  return buf;
}
