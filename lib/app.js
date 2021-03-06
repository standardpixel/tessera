"use strict";

var path = require("path"),
    url = require("url"),
    util = require("util");

var express = require("express"),
    handlebars = require("handlebars"),
    mercator = new (require("sphericalmercator"))();

var getInfo = function(source, callback) {
  return source.getInfo(function(err, _info) {
    if (err) {
      return callback(err);
    }

    var info = {};

    Object.keys(_info).forEach(function(key) {
      info[key] = _info[key];
    });

    if (info.vector_layers) {
      info.format = "pbf";
    }

    info.name = info.name || "Untitled";
    info.center = info.center || [-122.4440, 37.7908, 12];
    info.bounds = info.bounds || [-180, -85.0511, 180, 85.0511];
    info.format = info.format || "png";
    info.minzoom = Math.max(0, info.minzoom | 0);
    info.maxzoom = info.maxzoom || Infinity;

    return callback(null, info);
  });
};

// TODO a more complete implementation of this exists...somewhere
var getExtension = function(format) {
  // trim PNG variant info
  switch ((format || "").replace(/^(png).*/, "$1")) {
  case "png":
    return "png";

  default:
    return format;
  }
};

var normalizeHeaders = function(headers) {
  var _headers = {};

  Object.keys(headers).forEach(function(x) {
    _headers[x.toLowerCase()] = headers[x];
  });

  return _headers;
};

module.exports = function(tilelive, options) {
  var app = express().disable("x-powered-by"),
      templates = {},
      uri = options,
      tilePath = "/{z}/{x}/{y}.{format}",
      tilePattern;

  if (typeof(options) === "object") {
    uri = options.source;
    tilePath = options.tilePath || tilePath;

    Object.keys(options.headers || {}).forEach(function(name) {
      templates[name] = handlebars.compile(options.headers[name]);

      // attempt to parse so we can fail fast
      try {
        templates[name]();
      } catch (e) {
        console.error("'%s' header is invalid:", name);
        console.error(e.message);
        process.exit(1);
      }
    });
  }

  tilePattern = tilePath
    .replace(/\.(?!.*\.)/, ":retina(@2x)?.")
    .replace(/\./g, "\.")
    .replace("{z}", ":z(\\d+)")
    .replace("{x}", ":x(\\d+)")
    .replace("{y}", ":y(\\d+)")
    .replace("{format}", ":format([\\w\\.]+)");

  var populateHeaders = function(headers, params, extras) {
    Object.keys(extras || {}).forEach(function(k) {
      params[k] = extras[k];
    });

    Object.keys(templates).forEach(function(name) {
      var val = templates[name](params);

      if (val) {
        headers[name.toLowerCase()] = val;
      }
    });

    return headers;
  };

  // warm the cache
  tilelive.load(uri);

  var retinaURI = url.parse(uri, true);
  retinaURI.query.scale = 2;
  retinaURI.query.tileWidth = 512;
  retinaURI.query.tileHeight = 512;
  retinaURI.query.scaleMatchesZoom = false;

  var sourceURIs = {
    "@1x": uri,
    "@2x": url.format(retinaURI)
  };

  app.get(tilePattern, function(req, res, next) {
    var z = req.params.z | 0,
        x = req.params.x | 0,
        y = req.params.y | 0,
        retina = !!req.params.retina,
        sourceURI = sourceURIs["@1x"],
        params = {
          tile: {
            zoom: z,
            x: x,
            y: y,
            format: req.params.format,
            retina: retina
          }
        };


    if (retina) {
      sourceURI = sourceURIs["@2x"];
    }

    return tilelive.load(sourceURI, function(err, source) {
      if (err) {
        return next(err);
      }

      return getInfo(source, function(err, info) {
        if (err) {
          return next(err);
        }

        // console.log(info.scheme);
        // y = (1 << z) - 1 - y;

        // validate format / extension
        var ext = getExtension(info.format);

        if (ext !== req.params.format) {
          console.warn("Invalid format '%s', expected '%s'", req.params.format, ext);
          res.set(populateHeaders({}, params, { 404: true, invalidFormat: true }));
          return res.send(404);
        }

        // validate zoom
        if (z < info.minzoom || z > info.maxzoom) {
          console.warn("Invalid zoom:", z);
          res.set(populateHeaders({}, params, { 404: true, invalidZoom: true }));
          return res.send(404);
        }

        // validate coords against bounds
        var xyz = mercator.xyz(info.bounds, z);

        if (x < xyz.minX ||
            x > xyz.maxX ||
            y < xyz.minY ||
            y > xyz.maxY) {
          console.warn("Invalid coordinates: %d,%d relative to bounds:", x, y, xyz);
          res.set(populateHeaders({}, params, { 404: true, invalidCoordinates: true }));
          return res.send(404);
        }

        return source.getTile(z, x, y, function(err, data, headers) {
          headers = normalizeHeaders(headers || {});

          if (err) {
            if (err.message.match(/Tile|Grid does not exist/)) {
              res.set(populateHeaders(headers, params, { 404: true }));
              return res.send(404);
            }

            return next(err);
          }

          if (data === null) {
            res.set(populateHeaders(headers, params, { 404: true }));
            return res.send(404);
          }

          // work-around for PBF MBTiles that don't contain appropriate headers
          if (ext === "pbf") {
            headers["content-type"] = headers["content-type"] || "application/x-protobuf";
            headers["content-encoding"] = headers["content-encoding"] || "deflate";
          }

          res.set(populateHeaders(headers, params, { 200: true }));
          return res.send(data);
        });
      });
    });
  });

  app.get("/index.json", function(req, res, next) {
    var params = {
      tileJSON: true
    };

    return tilelive.load(uri, function(err, source) {
      if (err) {
        return next(err);
      }

      return getInfo(source, function(err, info) {
        if (err) {
          return next(err);
        }

        var uri = "http://" + req.headers.host +
          path.normalize(path.dirname(req.originalUrl) +
                         tilePath.replace("{format}",
                                          getExtension(info.format)));

        info.tiles = [uri];
        info.tilejson = "2.0.0";

        res.set(populateHeaders({}, params, { 200: true }));
        return res.send(info);
      });
    });
  });

  return app;
};
