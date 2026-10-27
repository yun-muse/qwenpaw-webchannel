# -*- coding: utf-8 -*-
"""WebChannel plugin entry point."""

import logging

from qwenpaw.plugins.api import PluginApi

logger = logging.getLogger(__name__)


class WebChannelPlugin:
    """Registers the self-hosted web channel with QwenPaw."""

    def register(self, api: PluginApi):
        """Register the WebChannel with its config fields."""
        try:  # package-relative when loaded as part of the plugin package
            from .channel import WebChannel
        except ImportError:  # loaded as a top-level module by the loader
            from channel import WebChannel

        api.register_channel(
            channel_class=WebChannel,
            label="Web",
            description=(
                "Self-hosted web frontend over the WebChannel relay "
                "(WebSocket, per-delta streaming)"
            ),
            config_fields=[
                {
                    "name": "relay_url",
                    "label": "Relay URL",
                    "type": "text",
                    "required": True,
                    "placeholder": "ws://127.0.0.1:8787/ws/agent",
                    "default": "ws://127.0.0.1:8787/ws/agent",
                },
                {
                    "name": "token",
                    "label": "Agent Token",
                    "type": "password",
                    "required": True,
                    "placeholder": "dev-agent-token",
                    "default": "dev-agent-token",
                },
                {
                    "name": "turso_url",
                    "label": "Turso DB URL",
                    "type": "text",
                    "required": False,
                    "placeholder": "libsql://webchannel-chats-<org>.turso.io",
                    "default": "",
                },
                {
                    "name": "turso_token",
                    "label": "Turso DB Token",
                    "type": "password",
                    "required": False,
                    "placeholder": "",
                    "default": "",
                },
            ],
        )
        logger.info("✓ WebChannel registered")


# Export plugin instance
plugin = WebChannelPlugin()
