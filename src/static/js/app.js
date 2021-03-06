var AWESOMATION = (function() {

  var net = (function() {
    function login(jqXHR, data, textStatus) {
      if (jqXHR.statusCode().status == 401) {
        window.location.replace('/_ah/login?continue=/');
      }
    }

    return {
      get: function(url, success) {
        return $.ajax(url, {
          method: "get",
          success: success
        }).fail(login);
      },
      post: function(url, body) {
        return $.ajax(url, {
          method: "post",
          contentType: "application/json; charset=utf-8",
          data: JSON.stringify(body)
        }).fail(login);
      },
      del: function(url) {
        return $.ajax(url, {
          method: 'delete',
        }).fail(login);
      }
    };
  }());

  var cache = (function() {
    var types = ['room', 'device', 'account', 'user'];
    var objects = {};
    $.each(types, function(i, type) {
      objects[type] = {};
    });

    function getUser() {
      for (var user_id in objects.user) {
        if (objects.user.hasOwnProperty(user_id)) {
          return objects.user[user_id];
        }
      }
    }

    function logout() {
      var url = getUser().logout_url;
      if (url !== null) {
        window.location.replace(url);
      }
    }

    var cache = {
      loading: true,
      objects: objects,
      logout: logout,
      getUser: getUser,
    };

    function fetch() {
      var loaded = types.length;

      $.each(types, function(i, type) {
        net.get(sprintf('/api/%s', type), function(result) {
          objects[type] = {};
          $.each(result.objects, function(i, object) {
            objects[type][object.id] = object;
          });

          loaded--;
          if (loaded === 0) {
            cache.loading = false;
            $('body').trigger('cache_updated');
          }
        });
      });
    }

    function handle_events(events) {
      $.each(events, function(i, event) {
        if ('c' in event) {
          var decoded = atob(event.c);
          var uncompressed = pako.inflate(decoded, {to: 'string'});
          event = JSON.parse(uncompressed);
        }

        switch (event.event) {
        case 'delete':
          delete objects[event.cls][event.id];
          break;
        case 'update':
          objects[event.cls][event.id] = event.obj;
          break;
        }
      });
      $('body').trigger('cache_updated');
    }

    function disconnected() {
      // Tell UI cache is now loading again
      cache.loading = true;
      $('body').trigger('cache_updated');

      // reset cache, connect channel, fetch
      cache.objects = (objects = {});
    }

    (function () {
      var pusher = new Pusher('58c733f69ae8d5b639e0', {encrypted: true,
        authEndpoint: '/api/user/channel_auth'});
      var socket;

      pusher.connection.bind('error', function(err) {
        console.log(err);
      });

      pusher.connection.bind('state_change', function(states) {
        console.log(states.current);
        if (states.current !== 'connected') {
          disconnected();
        }
      });

      net.get('/api/user').done(function (response) {
        // For now we'll just always connect to the
        // first building.
        var data = response.objects[0];
        var building_id = data.buildings[0];
        var channel_id = sprintf('private-%s', building_id);

        if ('ws' in data) {
          // running locally, so just use plain old websocket
          socket = new WebSocket(data.ws);
          socket.onopen = function (event) {
            socket.send(JSON.stringify({channel: channel_id}));
            fetch();
          };
          socket.onmessage = function (event) {
            handle_events(JSON.parse(event.data));
          };
        } else {
          var channel = pusher.subscribe(channel_id);
          channel.bind('events', function(data) {
            handle_events(data);
          });
          channel.bind('pusher:subscription_succeeded', function() {
            console.log('subscribed to push channel.');
            fetch();
          });
        }
      });
    }());

    return cache;
  }());

  var utils = {
    'object_name': function(obj) {
      if (obj.name) {
        return obj.name;
      }

      if (obj.device_name) {
        return obj.device_name;
      }

      if (obj.class == 'Room') {
        return sprintf('Room %s', obj.id);
      }

      if (obj.human_type) {
        return sprintf('%s account', obj.human_type);
      }

      return sprintf('%s (%s)', obj.id, obj.class);
    },

    'sort_by_name': function(objects) {
      objects = $.map(objects, function(obj) {
        return obj;
      });
      objects.sort(function (obj1, obj2) {
        return String.prototype.localeCompare.call(
          utils.object_name(obj1), utils.object_name(obj2));
      });
      return objects;
    },

    'has_intersection': function(a, b) {
      a.sort(); b.sort();
      var i=0, j=0;
      while( i < a.length && j < b.length )
      {
         if      (a[i] < b[j] ){ i++; }
         else if (a[i] > b[j] ){ j++; }
         else /* they're equal */
         {
           return true;
         }
      }
      return false;
    },

    'random_id': function() {
      return ("0000" + (Math.random() * Math.pow(36,4) << 0).toString(36)).slice(-4);
    },

    'reverse_color_temp': function(ct) {
      return 500 - ct;
    }
  };

  Handlebars.registerHelper({
    'Name': utils.object_name,

    'NameSort': function(objects, options) {
      objects = utils.sort_by_name(objects);
      return Handlebars.helpers.each(objects, options);
    },

    'IfEquals': function(a, b, options) {
      if (a === b) {
        return options.fn(this);
      } else {
        return options.inverse(this);
      }
    },

    'IfMod': function(a, b, options) {
      var test = ((a + 1) % b) === 0;
      if (test) {
        return options.fn(this);
      } else {
        return options.inverse(this);
      }
    },

    'IsEmpty': function(obj, options) {
      if ($.isEmptyObject(obj)) {
        return options.fn(this);
      } else {
        return options.inverse(this);
      }
    },

    'IfRoomExpandCapability': function(state, capability, options) {
      var key = sprintf('show-%s-%s', capability, this.id);
      if (state[key]) {
        return options.fn(this);
      } else {
        return options.inverse(this);
      }
    },

    'HasCapability': function(capability, options) {
      if (this.capabilities.indexOf(capability) >= 0) {
        return options.fn(this);
      } else {
        return options.inverse(this);
      }
    },

    'HomelessDevices': function(options) {
      var devices = $.map(cache.objects.device, function(device) {
        if (!(device.room in cache.objects.room)) {
          return device;
        }
      });

      devices = utils.sort_by_name(devices);
      return Handlebars.helpers.each(devices, options);
    },

    'RoomHasDevicesInCategory': function(category, options) {
      var room_id = this.id;
      var found = false;
      $.each(cache.objects.device, function(_, device) {
        found = device.room == room_id && device.categories.indexOf(category) >= 0;
        return !found; // break when we find the first one.
      });

      if (found) {
        return options.fn(this);
      } else {
        return options.inverse(this);
      }
    },

    'DevicesInCategory': function(category, options) {
      var room_id = this.id;
      var devices = $.map(cache.objects.device, function(device) {
        if (device.room === room_id && device.categories.indexOf(category) >= 0) {
          return device;
        }
      });

      devices = utils.sort_by_name(devices);
      return Handlebars.helpers.each(devices, options);
    },

    'DevicesNotInCategories': function(options) {
      var room_id = this.id;
      var categories = ['LIGHTING', 'CLIMATE', 'MUSIC'];
      var devices = $.map(cache.objects.device, function(device) {
        if (device.room === room_id && !utils.has_intersection(device.categories, categories)) {
          return device;
        }
      });

      devices = utils.sort_by_name(devices);
      return Handlebars.helpers.each(devices, options);
    },

    'CategoryInfo': function(category, options) {
      var room_id = this.id;
      var devices = $.map(cache.objects.device, function(device) {
        if (device.room === room_id && device.categories.indexOf(category) >= 0) {
          return device;
        }
      });

      var data = {};

      switch(category) {
      case 'LIGHTING':
        data.state = false;
        var brightness_count = 0,
          brightness_sum = 0;

        $.each(devices, function(_, device) {
          if (device.capabilities.indexOf('SWITCH') >= 0) {
            data.state |= device.state;
          }

          if (device.capabilities.indexOf('DIMMABLE') >= 0) {
            brightness_count++;
            brightness_sum += device.brightness;
          }
        });

        if (brightness_count > 0) {
          data.show_brightness = true;
          data.brightness = brightness_sum / brightness_count;
        } else {
          data.show_brightness = false;
        }
        break;

      case 'CLIMATE':
        var keys = ['temperature', 'humidity', 'co2', 'pressure', 'noise', 'lux'];

        $.each(devices, function(_, device) {
          $.each(keys, function(_, key) {
            value = device[key];
            if (value === undefined) return;

            if (data[sprintf('%s-min', key)] === undefined) {
              data[sprintf('%s-min', key)] = value;
              data[sprintf('%s-max', key)] = value;
            } else {
              data[sprintf('%s-min', key)] = Math.min(value, data[sprintf('%s-min', key)]);
              data[sprintf('%s-max', key)] = Math.max(value, data[sprintf('%s-max', key)]);
            }
          });
        });

        $.each(keys, function(_, key) {
          if (data[sprintf('%s-min', key)] === data[sprintf('%s-max', key)]) {
            data[key] = data[sprintf('%s-max', key)];
            delete data[sprintf('%s-min', key)];
            delete data[sprintf('%s-max', key)];
          }
        });
        break;
      }

      return options.fn(data);
    },

    'HumanTime': function(millis) {
      return moment(millis).format('LLL');
    },

    'PercentOf': function(numerator, denominator) {
      return sprintf('%d', numerator * 100.0 / denominator);
    },

    'DevicesForAccount': function(account_id, options) {
      var devices = $.map(cache.objects.device, function(device) {
        if (device.account === account_id) {
          return device;
        }
      });

      if (devices) {
        var result = $.map(utils.sort_by_name(devices), options.fn);
        return result.join(', ');
      }

      return options.inverse(this);
    },

    'ExtractHours': function(seconds) {
      return Math.floor(seconds / 3600);
    },

    'ExtractMinutes': function(seconds) {
      rem = seconds % 3600;
      return Math.floor(rem / 60);
    },

    'InvertColorTemp': function(ct) {
      return 500 - ct;
    },

    'Category': function(category, options) {
      if (this.categories && this.categories.indexOf(category) >= 0) {
        return options.fn(this);
      } else {
        return options.inverse(this);
      }
    },

    'IconFor': function() {
      this.categories.sort();
      var result = $.map(this.categories, function(category) {
        switch(category) {
          case 'PRESENCE': return 'glyphicons-iphone';
          case 'LIGHTING': return 'glyphicons-lightbulb';
          case 'MUSIC': return 'glyphicons-music';
          case 'CLIMATE': return 'glyphicons-cloud';
        }
      });
      if (result.length > 0) {
        return result[0];
      }
    },

    'Int': function(i) {
      return sprintf('%d', i);
    },

    'Float': function(d) {
      return sprintf('%.1f', d);
    }
  });

  $(function () {
    $('script.handlebars-partial').each(function() {
      var that = $(this);
      Handlebars.registerPartial(this.id, that.html());
    });

    function render() {
      var state = $.bbq.getState(true);
      var mode = state.mode || 'devices';

      // Update the selected status on the left.
      $('.nav li').removeClass('active');
      $(sprintf('.nav li[data-mode=%s]', mode)).addClass('active');

      // Rendem the main view.
      var template = $(sprintf('script#%s-template', mode)).text();
      template = Handlebars.compile(template);

      var data = {
        loading: cache.loading,
        objects: cache.objects,
        state: state
      };
      var rendered = template(data);
      $('div#main').html(rendered);

      if (mode == 'history') {
        render_history();
      }
    }

    $('body').on('cache_updated', render);
    $(window).bind('hashchange', render);
    render();

    $(window).on('scroll', function(e) {
      var distanceY = window.pageYOffset || document.documentElement.scrollTop,
        shrinkOn = 50;

      $(".header").toggleClass('smaller', distanceY > shrinkOn);
    });

    $('body').on('click', 'a[href=#]', function(event) {
      event.preventDefault();
    });

    $('body').on('submit', 'form', function(event) {
      event.preventDefault();
    });

    $('.nav li').on('click', function() {
      var mode = $(this).data('mode');
      $.bbq.pushState({mode: mode});
    });

    $('div#main').on('click', '.state-set', function() {
      var data = {};
      data[$(this).data('key')] = $(this).data('value');
      $.bbq.pushState(data);
    });

    $('div#main').on('click', 'div.room .room-set', function() {
      var room_id = $(this).closest('div.room').data('room-id');
      var data = {};
      data[$(this).data('key')] = $(this).data('value');

      net.post(sprintf('/api/room/%s', room_id), data);
    });

    function room_set_lighting_state(room_id, state) {
      // If we found a light that is on, turn them all off.
      var command = state ? 'all_on' : 'all_off';

      net.post(sprintf('/api/room/%s/command', room_id), {
        command: command,
      });
    }

    $('.all-off').on('click', function() {
      $.each(cache.objects.room, function(room_id) {
        room_set_lighting_state(room_id, false);
      });
    });

    $('div#main').on('change', 'div.device input.on-change-device-set', function() {
      var that = $(this),
        device_id = that.closest('div.device').data('device-id'),
        modify = that.data('modify'),
        key = that.data('key'),
        value = parseInt(that.val()),
        data = {};
      data[key] = modify ? utils[modify](value) : value;
      net.post(sprintf('/api/device/%s', device_id), data);
    });

    $('div#main').on('click', 'div.device .device-set', function() {
      var device_id = $(this).closest('div.device').data('device-id');
      var data = {};
      data[$(this).data('key')] = $(this).data('value');

      net.post(sprintf('/api/device/%s', device_id), data);
    });

    $('div#main').on('click', 'div.device .device-command', function() {
      var device_id = $(this).closest('div.device').data('device-id');
      var command = $(this).data('command');

      net.post(sprintf('/api/device/%s/command', device_id), {
        command: command,
      });
    });

    $('div#main').on('click', 'div.account .account-command', function() {
      var account_id = $(this).closest('div.account').data('account-id');
      var command = $(this).data('command');

      net.post(sprintf('/api/account/%s/command', account_id), {
        command: command,
      });
    });

    $('div#main').on('click', '.switch-on, .switch-off', function() {
      var device_id = $(this).closest('div.device').data('device-id');
      var data = {
        state: $(this).hasClass('switch-on'),
        intended_state: $(this).hasClass('switch-on'),
        state_last_update: moment().unix()
      };

      net.post(sprintf('/api/device/%s', device_id), data);
    });

    $('div#main').on('click', 'div.room .lighting-toggle', function() {
      var room_id = $(this).closest('div.room').data('room-id');
      var devices = $.map(cache.objects.device, function(device) {
        if (device.room === room_id &&
            device.categories.indexOf('LIGHTING') >= 0 &&
            device.capabilities.indexOf('SWITCH') >= 0 &&
            device.state) {
          return device;
        }
      });

      room_set_lighting_state(room_id, devices.length === 0);
    });

    $('.logout').on('click', function() {
      cache.logout();
    });

    function render_history() {
      $.each(cache.objects.room, function(room_id) {
        net.post(sprintf('/api/room/%s/history', room_id), {
          start_time: moment().subtract(1, 'weeks').unix(),
          end_time: moment().unix()
        }).done(function (data) {
          console.log(data);
        });
      });

      var data = [
        {room: 'Office',
         start: new Date("Sun Dec 09 01:36:45 EST 2012"),
         end: new Date("Sun Dec 09 02:36:45 EST 2012")}
       ];

      var margin = {top: 20, right: 30, bottom: 30, left: 40},
          width = 960 - margin.left - margin.right,
          height = 500 - margin.top - margin.bottom;

      var x = d3.time.scale()
          .range([0, width])
          .domain([
            d3.min(data, function(d) { return d.start; }),
            d3.max(data, function(d) { return d.end; })
          ]);

      var y = d3.scale.ordinal()
          .rangeRoundBands([height, 0], 0.1)
          .domain(data.map(function(d) { return d.room; }));

      var xAxis = d3.svg.axis()
          .scale(x)
          .orient("bottom");

      var yAxis = d3.svg.axis()
          .scale(y)
          .orient("left");

      var chart = d3.select("#history")
          .attr("width", width + margin.left + margin.right)
          .attr("height", height + margin.top + margin.bottom)
          .append("g")
            .attr("transform", "translate(" + margin.left + "," + margin.top + ")");

      chart.append("g")
          .attr("class", "x axis")
          .attr("transform", "translate(0," + height + ")")
          .call(xAxis);

      chart.append("g")
          .attr("class", "y axis")
          .call(yAxis);

      chart.selectAll(".bar")
          .data(data)
          .enter().append("rect")
            .attr("class", "bar")
            .attr("x", function(d) { return x(d.start); })
            .attr("y", function(d) { return y(d.name); })
            .attr("height", y.rangeBand())
            .attr("width", function(d) { return x(d.end); });
    }

    // Dialogs

    var dialog = (function () {
      var modal = $('div.modal#main_modal');
      modal.modal({show: false});

      var on_success = null;
      modal.on('shown.bs.modal', function () {
        $(this).find('input').first().focus();
      });

      function show(name, obj, f) {
        var template = Handlebars.compile($(name).text());
        var rendered = template(obj);
        on_success = f;
        modal.html(rendered);
        modal.modal('show');
      }

      function hide() {
        $('.modal#main_modal')
          .modal('hide')
          .html('');
      }

      modal.on('click', '.btn-primary', function() {
        var result = on_success.apply(modal, arguments);
        if (result === undefined || result === true) {
          hide();
        }
      });

      modal.on('submit', 'form', function() {
        // If there is a primary button in the form,
        // click that.  Otherwise click the primary button
        // in the modal.
        var form_button = $(this).find('.btn-primary');
        if (form_button.length > 0) {
          form_button.trigger('click');
          return;
        }

        modal.find('.btn-primary').trigger('click');
      });

      return {
        show: show,
        hide: hide
      };
    }());

    function render_error(jqXHR, textStatus, errorThrown) {
      var message;
      try {
        var error = $.parseJSON(jqXHR.responseText);
        message = error.message;
      } catch (e) {
        message = errorThrown;
      }

      var template = $('script#error-template').text();
      template = Handlebars.compile(template);
      return template({message: message});
    }

    // Dialog: create new room

    $('.create-new-room').on('click', function() {
      dialog.show('script#create-new-room-dialog-template', {}, function() {
        var room_id = utils.random_id();
        var room_name = $(this).find('input#room-name').val();

        net.post(sprintf('/api/room/%s', room_id), {
          name: room_name,
        });
      });
    });

    // Dialog: add new device

    $('.add-new-device').on('click', function() {
      function new_device(event) {
        var that = $(this);
        var type = $(event.target).data('type');
        switch(type) {

        case 'rfswitch':
          (function() {
            var device_id = utils.random_id();
            var device_name = that.find('input#device-name').val();
            var system_code = that.find('input#system-code').val();
            var device_code = parseInt(that.find('input#device-code').val());
            var room_id = that.find('select#room').val();

            net.post(sprintf('/api/device/%s', device_id), {
              type: 'rfswitch',
              name: device_name,
              system_code: system_code,
              device_code: device_code,
              room: room_id
            }).done(function () {
              dialog.hide();
            }).fail(function (jqXHR, textStatus, errorThrown) {
              that.find('input#proxy-id')
                .closest('div.form-group')
                .siblings('.error_placeholder')
                  .html(render_error(jqXHR, textStatus, errorThrown));
            });
          }());
          break;

        case 'proxy':
          (function() {
            var proxy_id = that.find('input#proxy-id').val();
            net.post('/api/proxy/claim', {
              proxy_id: proxy_id
            }).done(function () {
              dialog.hide();
            }).fail(function (jqXHR, textStatus, errorThrown) {
              that.find('input#proxy-id')
                .closest('div.form-group')
                .addClass('has-error')
                .siblings('.error_placeholder')
                  .html(render_error(jqXHR, textStatus, errorThrown));
            });
          }());
          break;

        case 'network':
          (function() {
            var device_name = that.find('input#network-device-name').val();
            var mac_address = that.find('input#mac-address').val();
            mac_address = mac_address.toLowerCase();

            MAC_REGEX = /^([0-9a-f]{2}[:-]){5}([0-9a-f]{2})$/;
            if (!MAC_REGEX.test(mac_address)) {
              var error_html = render_error(null, null, 'MAC Address should be of the form \'71:50:FF:59:4C:1E\'.');

              that.find('input#mac-address')
                .closest('div.form-group')
                .addClass('has-error')
                .siblings('.error_placeholder')
                  .html(error_html);
              return false; // don't close the dialog
            }

            net.post(sprintf('/api/device/mac-%s', mac_address), {
              type: 'network',
              name: device_name
            }).done(function () {
              dialog.hide();
            }).fail(function (jqXHR, textStatus, errorThrown) {
              that.find('input#mac-address')
                .closest('div.form-group')
                .addClass('has-error')
                .siblings('.error_placeholder')
                  .html(render_error(jqXHR, textStatus, errorThrown));
            });
          }());
          break;
        }

        return false;
      }

      dialog.show('script#new-device-dialog-template',
             {rooms: cache.objects.room},
             new_device);
    });

    // Dialog: configuring sharing

    $('.configure-sharing').on('click', function() {
      dialog.show('script#configure-sharing-dialog-template', cache.getUser(), function() {
        var email = $(this).find('input#invite-email').val();

        net.post('/api/user/invite', {
          email: email,
        });
      });
    });

    $('div#main_modal').on('click', '.delete-invite', function() {
      var invite_id = $(this).closest('li[data-invite-id]').data('invite-id');
      net.del(sprintf('/api/user/invite/%s', invite_id));
    });

    // Dialog: change room name

    $('div#main').on('click', 'div.room .room-change-name', function() {
      var room_id = $(this).closest('div.room').data('room-id');
      var room = cache.objects.room[room_id];

      dialog.show('script#room-change-name-dialog-template', room, function() {
        var room_name = $(this).find('input#room-name').val();
        net.post(sprintf('/api/room/%s', room_id), {
          name: room_name,
        });
      });
    });

    $('div#main').on('click', 'div.room .room-update-lights', function() {
      var room_id = $(this).closest('div.room').data('room-id');
      net.post(sprintf('/api/room/%s/command', room_id), {
        command: 'update_lights',
      });
    });

    // Dialog: setup auto dimming

    $('div#main').on('click', 'div.room .configure-auto-dim', function() {
      var room_id = $(this).closest('div.room').data('room-id');
      var room = cache.objects.room[room_id];

      dialog.show('script#setup-auto-dimming-dialog-template', room, function() {
        var enable = $(this).find('input#enable-auto-dim').is(':checked');
        var start_hours = $(this).find('input#start-hours').val();
        var start_mins = $(this).find('input#start-mins').val();
        var end_hours = $(this).find('input#end-hours').val();
        var end_mins = $(this).find('input#end-mins').val();
        var target_brightness = $(this).find('input#target-brightness').val();
        var target_color_temperature = $(this).find('input#target-color-temperature').val();

        net.post(sprintf('/api/room/%s', room_id), {
          auto_dim_lights: enable,
          target_brightness: parseInt(target_brightness),
          target_color_temperature: utils.reverse_color_temp(parseInt(target_color_temperature)),
          dim_start_time: (start_hours * 3600) + (start_mins * 60),
          dim_end_time: (end_hours * 3600) + (end_mins * 60),
        }).always(function() {
          net.post(sprintf('/api/room/%s/command', room_id), {
            command: 'update_lights'
          });
        });
      });
    });

    // Dialog: delete room

    $('div#main').on('click', 'div.room .room-delete', function() {
      var room_id = $(this).closest('div.room').data('room-id');
      var room = cache.objects.room[room_id];

      dialog.show('script#delete-room-dialog-template', room, function() {
        net.del(sprintf('/api/room/%s', room_id));
      });
    });

    // Dialog: device change room

    $('div#main').on('click', 'div.device .device-change-room', function() {
      var device_id = $(this).closest('div.device').data('device-id');
      var state = {rooms: cache.objects.room, device: cache.objects.device[device_id]};

      dialog.show('script#device-change-room-dialog-template', state, function() {
        var room_id = $(this).find('select#room').val();
        net.post(sprintf('/api/device/%s', device_id), {
          room: room_id
        });
      });
    });

    // Dialog: change device name

    $('div#main').on('click', 'div.device .device-change-name', function() {
      var device_id = $(this).closest('div.device').data('device-id');
      var device = cache.objects.device[device_id];

      dialog.show('script#device-change-name-dialog-template', device, function() {
        var device_name = $(this).find('input#device-name').val();
        net.post(sprintf('/api/device/%s', device_id), {
          name: device_name,
        });
      });
    });

    // Dialog: delete device

    $('div#main').on('click', 'div.device .device-delete', function() {
      var device_id = $(this).closest('div.device').data('device-id');
      var device = cache.objects.device[device_id];

      dialog.show('script#delete-device-dialog-template', device, function() {
        net.del(sprintf('/api/device/%s', device_id));
      });
    });

    // Dialog: delete account

    $('div#main').on('click', 'div.account .delete-account', function() {
      var account_id = $(this).closest('div.account').data('account-id');
      var account = cache.objects.account[account_id];

      dialog.show('script#delete-account-dialog-template', account, function() {
        net.del(sprintf('/api/account/%s', account_id));
      });
    });
  });

  return {
    net: net,
    cache: cache
  };
})();
