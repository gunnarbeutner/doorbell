"""A virtual-time media player backed by real WAV metadata."""

from io import BytesIO
import wave

import esphome.codegen as cg
from esphome.components import audio, audio_file, media_player
import esphome.config_validation as cv
from esphome.const import CONF_FILES

from . import firmware_test_ns

CODEOWNERS = []
DEPENDENCIES = ["firmware_test"]

FakeMediaPlayer = firmware_test_ns.class_(
    "FakeMediaPlayer", media_player.MediaPlayer, cg.Component
)

CONFIG_SCHEMA = media_player.media_player_schema(FakeMediaPlayer).extend(
    {
        cv.Required(CONF_FILES): audio_file.audio_files_schema(),
    }
).extend(cv.COMPONENT_SCHEMA)


async def to_code(config):
    var = await media_player.new_media_player(config)
    await cg.register_component(var, config)

    for file_config in config[CONF_FILES]:
        data, _ = audio_file.read_audio_file_and_type(file_config)
        with wave.open(BytesIO(data), "rb") as wav:
            duration_ms = round(wav.getnframes() * 1000 / wav.getframerate())
        file_var = audio_file.generate_audio_file_code(file_config)
        cg.add(var.add_file(file_var, str(file_config["id"]), duration_ms))
