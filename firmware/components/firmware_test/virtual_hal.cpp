#include "firmware_test.h"

#include "esphome/core/hal.h"
#include "esphome/core/wake.h"

#include <atomic>
#include <cstdlib>
#include <sched.h>
#include <sys/select.h>

namespace esphome {

std::atomic<uint8_t> g_wake_requested{0};

uint32_t millis() { return static_cast<uint32_t>(firmware_test::FirmwareTestBridge::virtual_millis()); }
uint64_t millis_64() { return firmware_test::FirmwareTestBridge::virtual_millis(); }
uint32_t micros() { return static_cast<uint32_t>(firmware_test::FirmwareTestBridge::virtual_millis() * 1000ULL); }

void delay(uint32_t ms) {
  if (auto *bridge = firmware_test::get_bridge())
    bridge->advance(ms);
  else
    firmware_test::FirmwareTestBridge::set_virtual_millis(
        firmware_test::FirmwareTestBridge::virtual_millis() + ms);
}
void delayMicroseconds(uint32_t us) {
  if (us >= 1000)
    delay((us + 999) / 1000);
}
uint32_t arch_get_cpu_cycle_count() { return micros(); }
void arch_restart() { std::exit(0); }

bool wake_register_fd(int fd) {
  (void) fd;
  return true;
}
void wake_unregister_fd(int fd) { (void) fd; }
void wake_setup() {}
void wake_loop_threadsafe() { wake_request_set(); }

namespace internal {
int g_wake_socket_fd = -1;
fd_set g_read_fds{};

void wakeable_delay(uint32_t ms) {
  if (auto *bridge = firmware_test::get_bridge())
    bridge->advance(ms);
  else if (ms != 0)
    firmware_test::FirmwareTestBridge::set_virtual_millis(
        firmware_test::FirmwareTestBridge::virtual_millis() + ms);
  else
    ::sched_yield();
}
}  // namespace internal

}  // namespace esphome
