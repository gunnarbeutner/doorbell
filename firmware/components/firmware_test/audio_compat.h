#pragma once

#include <cstddef>
#include <cstdint>

// The stock audio component is ESP32-only. The host player needs only its stable embedded-file ABI,
// so keep the test target independent of decoder/ring-buffer code while preserving the same type.
namespace esphome::audio {

enum class AudioFileType : uint8_t { NONE = 0, WAV = 1 };

struct AudioFile {
  const uint8_t *data;
  size_t length;
  AudioFileType file_type;
};

}  // namespace esphome::audio
