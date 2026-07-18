"""Deterministic host/circuit co-simulation bridge for the doorbell policy."""

import esphome.codegen as cg
from esphome.components import binary_sensor, button, select, sensor, switch
import esphome.config_validation as cv
from esphome.const import CONF_ID

CODEOWNERS = []
DEPENDENCIES = ["host"]
AUTO_LOAD = ["media_player"]

firmware_test_ns = cg.esphome_ns.namespace("firmware_test")
FirmwareTestBridge = firmware_test_ns.class_("FirmwareTestBridge", cg.Component)

CONF_HA_CONNECTED = "ha_connected"
CONF_AUTO_OPEN = "auto_open"
CONF_FORCE_CHIME = "force_chime"
CONF_SUPPRESS_CHIME = "suppress_chime"
CONF_NEXT_GREETING = "next_greeting"
CONF_PLAY_WELCOME = "play_welcome"
CONF_WELCOME_AND_OPEN = "welcome_and_open"
CONF_DOOR_OPEN = "door_open"
CONF_VBUS_SENSOR = "vbus_sensor"
CONF_HOUSE_RING = "house_ring"
CONF_APARTMENT_RING = "apartment_ring"
CONF_CHIME_ENABLED = "chime_enabled"
CONF_K5_SENSE = "k5_sense"
CONF_PHYSICAL_PTT = "physical_ptt"
CONF_MANUAL_PASSIVE_LISTEN = "manual_passive_listen"

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(FirmwareTestBridge),
        cv.Required(CONF_HA_CONNECTED): cv.use_id(binary_sensor.BinarySensor),
        cv.Required(CONF_AUTO_OPEN): cv.use_id(switch.Switch),
        cv.Required(CONF_FORCE_CHIME): cv.use_id(switch.Switch),
        cv.Required(CONF_SUPPRESS_CHIME): cv.use_id(switch.Switch),
        cv.Required(CONF_NEXT_GREETING): cv.use_id(select.Select),
        cv.Required(CONF_PLAY_WELCOME): cv.use_id(button.Button),
        cv.Required(CONF_WELCOME_AND_OPEN): cv.use_id(button.Button),
        cv.Required(CONF_DOOR_OPEN): cv.use_id(button.Button),
        cv.Required(CONF_VBUS_SENSOR): cv.use_id(sensor.Sensor),
        cv.Required(CONF_HOUSE_RING): cv.use_id(binary_sensor.BinarySensor),
        cv.Required(CONF_APARTMENT_RING): cv.use_id(binary_sensor.BinarySensor),
        cv.Required(CONF_CHIME_ENABLED): cv.use_id(binary_sensor.BinarySensor),
        cv.Required(CONF_K5_SENSE): cv.use_id(binary_sensor.BinarySensor),
        cv.Required(CONF_PHYSICAL_PTT): cv.use_id(binary_sensor.BinarySensor),
        cv.Required(CONF_MANUAL_PASSIVE_LISTEN): cv.use_id(binary_sensor.BinarySensor),
    }
).extend(cv.COMPONENT_SCHEMA)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    for key, setter in (
        (CONF_HA_CONNECTED, "set_ha_connected"),
        (CONF_AUTO_OPEN, "set_auto_open"),
        (CONF_FORCE_CHIME, "set_force_chime"),
        (CONF_SUPPRESS_CHIME, "set_suppress_chime"),
        (CONF_NEXT_GREETING, "set_next_greeting"),
        (CONF_PLAY_WELCOME, "set_play_welcome"),
        (CONF_WELCOME_AND_OPEN, "set_welcome_and_open"),
        (CONF_DOOR_OPEN, "set_door_open"),
        (CONF_VBUS_SENSOR, "set_vbus_sensor"),
        (CONF_HOUSE_RING, "set_house_ring"),
        (CONF_APARTMENT_RING, "set_apartment_ring"),
        (CONF_CHIME_ENABLED, "set_chime_enabled"),
        (CONF_K5_SENSE, "set_k5_sense"),
        (CONF_PHYSICAL_PTT, "set_physical_ptt"),
        (CONF_MANUAL_PASSIVE_LISTEN, "set_manual_passive_listen"),
    ):
        target = await cg.get_variable(config[key])
        cg.add(getattr(var, setter)(target))
