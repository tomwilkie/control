"""Factory for creating devices."""
import logging
import math
import time

from google.appengine.api import namespace_manager
from google.appengine.ext import ndb

import flask

from appengine import account, model, pushrpc, rest
from common import detector


DEVICE_TYPES = {}


def static_command(func):
  """Device command decorator - automatically dispatches methods."""
  setattr(func, 'is_command', True)
  setattr(func, 'is_static', True)
  return func


def register(device_type):
  """Decorator to cause device types to be registered."""
  def class_rebuilder(cls):
    DEVICE_TYPES[device_type] = cls
    return cls
  return class_rebuilder


def create_device(device_id, body, device_type=None):
  """Factory for creating new devices."""
  if device_type is None:
    device_type = body.pop('type', None)

  if device_type is None:
    flask.abort(400, '\'type\' field expected in body.')

  constructor = DEVICE_TYPES.get(device_type, None)
  if constructor is None:
    logging.error('No device type \'%s\'', device_type)
    flask.abort(400)
  return constructor(id=device_id)


class Device(model.Base):
  """Base class for all device drivers."""

  # This is the name the user sets
  name = ndb.StringProperty(required=False)

  # This is the (optional) name read from the device itself
  device_name = ndb.StringProperty(required=False)

  last_update = ndb.DateTimeProperty(required=False, auto_now=True)
  room = ndb.StringProperty()

  # What can I do with this device? ie SWITCH, DIMMABLE, COLOR_TEMP etc
  capabilities = ndb.ComputedProperty(lambda self: self.get_capabilities(),
                                      repeated=True)

  # What broad category does this device belong to?  LIGHTING, CLIMATE, MUSIC
  categories = ndb.ComputedProperty(lambda self: self.get_categories(),
                                    repeated=True)

  # Does this device belong to an account?
  account = ndb.StringProperty()

  def get_capabilities(self):
    return []

  def get_categories(self):
    return []

  @classmethod
  def _event_classname(cls):
    return 'device'

  def handle_event(self, event):
    pass

  @classmethod
  def handle_static_event(cls, event):
    pass

  @classmethod
  def get_by_capability(cls, capability):
    return cls.query(Device.capabilities == capability)

  def find_room(self):
    """Resolve the room for this device.  May return null."""
    if not self.room:
      return None

    # This is a horrible hack, but room imports devices,
    # so need to be lazy here.
    from appengine import room
    room_obj = room.Room.get_by_id(self.room)
    if not room_obj:
      return None

    return room_obj

  def find_account(self):
    """Resolve the account for this device.  May return null."""
    if not self.account:
      return None

    # This is a horrible hack, but room imports devices,
    # so need to be lazy here.
    account_obj = account.Account.get_by_id(self.account)
    if not account_obj:
      return None

    return account_obj


class DetectorMixin(object):
  """Add a failure detector to a device to interpret motion sensor data."""
  detector = ndb.JsonProperty()

  # These fields represent the real state of this sensor
  # and when the real state last changes
  occupied = ndb.BooleanProperty(default=False)
  occupied_last_update = ndb.IntegerProperty()

  # These fields represent the inferred state of this sensor
  # after processing by the failure detector, and the time
  # when this inferred state last changed.
  inferred_state = ndb.BooleanProperty(default=False)
  inferred_last_update = ndb.IntegerProperty(default=0)

  #def to_dict(self):
  #  """We don't need to expose the detector in the dict repr."""
  #  # Mainly as its too big for pusher
  #  result = super(DetectorMixin, self).to_dict()
  #  del result['detector']
  #  return result

  def _load_detector(self):
    """Either return the a rehydrated detector, or a fresh one."""
    if self.detector is None:
      return detector.AccrualFailureDetector()
    else:
      return detector.AccrualFailureDetector.from_dict(self.detector)

  def is_occupied(self):
    """Use a failure detector to determine state of sensor"""
    # Does the sensor say we're occupied?
    if self.occupied:
      return True

    # If not, does the detector?
    instance = self._load_detector()
    inferred_state = instance.is_alive()

    if self.inferred_state != inferred_state:
      self.inferred_state = inferred_state
      self.inferred_last_update = int(time.time())
      self.put()

    return inferred_state

  def real_occupied_state_change(self, state):
    """The underly state changed; synthensize events and save the detector."""
    now = int(time.time())
    logging.info('real_occupied_state_change %s, state=%s', self, state)

    # I'm getting dupe events; ignore until
    # I figure out why.
    if state == self.occupied:
      return

    instance = self._load_detector()

    # Construct an appropriate set of fake heartbeats and
    # feed them to the detector.
    # As we don't get heart beats from the motion sensors,
    # we just fake them.  We only do this if the sensor
    # is transitions from occupied -> not occupied.  We
    # don't need to do it for the other way as we just use
    # the real state.
    if self.occupied and self.occupied_last_update is not None:
      assert state == False
      # We know the first hit was at self.occupied_last_update.
      # We know the sensor can't have recieved a hit in the past
      # timeout seconds, so the last hit was now - timeout ago
      # Otherwise, we're going to put a bunch of hits inbetween
      # those times
      timeout = 240
      start = self.occupied_last_update
      end = now - timeout
      if start > end:
        logging.error("This shouldn't happen; start = %s < end = %s",
                      start, end)
        end = start + 1

      diff = end - start
      count = math.ceil(diff * 1.0 / timeout)
      if count > 0:
        inc = diff / count
        for i in xrange(int(count)):
          instance.heartbeat(start + int(i * inc))

    # save the detector and other fields
    # no need to put this object, plumbing in device.py
    # will do that for us.
    self.detector = instance.to_dict()
    self.occupied = state
    self.occupied_last_update = now

    room = self.find_room()
    if room:
      room.update_lights()


class Switch(Device):
  """A switch."""
  # Represents the actual state of the switch; changing this
  # (and calling update()) will changed the switch.
  state = ndb.BooleanProperty(default=False)

  # Represents the state the user wants, and when they asked for
  # it.  Most of the time users will control rooms etc, not individual
  # lights.  But its possible.
  # UI should set this and call update_lights on the room.
  intended_state = ndb.BooleanProperty()
  state_last_update = ndb.IntegerProperty(default=0)

  def get_capabilities(self):
    return ['SWITCH']

  def get_categories(self):
    return ['LIGHTING']


# pylint: disable=invalid-name
blueprint = flask.Blueprint('device', __name__)
rest.register_class(blueprint, Device, create_device)


def process_events(events):
  """Process a set of events."""

  device_cache = {}

  for event in events:
    device_type = event['device_type']
    device_id = event['device_id']
    event_body = event['event']

    if device_id is None:
      DEVICE_TYPES[device_type].handle_static_event(event_body)
      continue

    if device_id in device_cache:
      device = device_cache[device_id]
    else:
      device = Device.get_by_id(device_id)
      if not device:
        device = create_device(device_id, None,
                               device_type=device_type)
      device_cache[device_id] = device

    device.handle_event(event_body)

  ndb.put_multi(device_cache.values())


@blueprint.route('/events', methods=['POST'])
def handle_events():
  """Handle events from devices."""

  # This endpoint needs to authenticate itself.
  proxy = pushrpc.authenticate()
  if proxy is None:
    flask.abort(401)

  # If proxy hasn't been claimed, not much we can do.
  if proxy.building_id is None:
    logging.info('Dropping events as this proxy is not claimed')
    return ('', 204)

  # We need to set namespace - not done by main.py
  namespace_manager.set_namespace(proxy.building_id)

  events = flask.request.get_json()
  logging.info('Processing %d events', len(events))

  process_events(events)

  return ('', 204)


