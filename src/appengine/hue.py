"""Philips hue integration."""

import logging
import re

from google.appengine.ext import ndb

from appengine import model, pushrpc


class HueBridge(model.Device):
  """A hue bridge."""
  linked = ndb.BooleanProperty(required=True)

  @model.Command
  def scan(self):
    event = {'type': 'hue', 'command': 'scan'}
    pushrpc.send_event(self.owner, event)

  def handle_event(self, event):
    """Handle a device update event."""
    # Only events are when we find a bridge,
    # and we are told the name and linked status

    self.name = event['name']
    self.linked = event['linked']


LIGHT_ID_RE = re.compile(r'hue-([0-9a-f]+)-([0-9]+)')


class HueLight(model.Switch):
  """A hue light."""
  hue_type = ndb.StringProperty()
  hue_model_id = ndb.StringProperty()

  @model.Command
  def turn_on(self):
    self.state = True
    self._set_state(True)

  @model.Command
  def turn_off(self):
    self.state = False
    self._set_state(False)

  def _set_state(self, state):
    """Update the state of a light."""
    match = LIGHT_ID_RE.match(self.key.id())
    bridge_id = match.group(1)
    device_id = match.group(2)

    event = {'type': 'hue',
             'command': 'light',
             'bridge_id': bridge_id,
             'device_id': device_id,
             'mode': state}
    pushrpc.send_event(self.owner, event)

  def handle_event(self, event):
    """Handle a device update event."""
    logging.info(event)
    self.name = event['name']
    self.hue_type = event['type']
    self.hue_model_id = event['modelid']

    state = event['state']
    self.state = state['on']
