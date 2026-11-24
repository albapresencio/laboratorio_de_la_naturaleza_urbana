"""Shared map frame and geometry helpers.

The map uses a local equirectangular projection in metres around a centre point between Sol and Retiro.
Every data file in web/data is expressed in this frame, and web/app.js uses the same constants.
"""
import array
import base64
import math

LON0, LAT0 = -3.692, 40.418          # frame centre
HALF_W, HALF_H = 6000, 7000          # metres: a 12 x 14 km frame
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110574


def proj(lon, lat):
    """lon/lat (degrees) -> local x/y (metres)."""
    return (lon - LON0) * KX, (lat - LAT0) * KY


def unproj(x, y):
    """local x/y (metres) -> lon/lat (degrees)."""
    return LON0 + x / KX, LAT0 + y / KY


def inside(x, y, pad=0):
    return -HALF_W - pad <= x <= HALF_W + pad and -HALF_H - pad <= y <= HALF_H + pad


def simplify(pts, tol):
    """Douglas-Peucker on a list of (x, y); a closed ring falls back to the distance from its start point."""
    if len(pts) < 3:
        return pts
    keep, stack = {0, len(pts) - 1}, [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        best, bi = 0, -1
        for i in range(a + 1, b):
            ex, ey = pts[i][0] - ax, pts[i][1] - ay
            d = abs(dy * ex - dx * ey) / length if length > 1e-6 else math.hypot(ex, ey)
            if d > best:
                best, bi = d, i
        if best > tol:
            keep.add(bi)
            stack += [(a, bi), (bi, b)]
    return [pts[i] for i in sorted(keep)]


def delta_encode(pts, ox=0, oy=0):
    """[(x, y), ...] -> [dx0, dy0, dx1, dy1, ...], the first point relative to (ox, oy)."""
    out, px, py = [], ox, oy
    for x, y in pts:
        out += [x - px, y - py]
        px, py = x, y
    return out


def delta_decode(d):
    """Inverse of delta_encode with a (0, 0) origin."""
    pts, px, py = [], 0, 0
    for i in range(0, len(d), 2):
        px += d[i]
        py += d[i + 1]
        pts.append((px, py))
    return pts


def b64(arr):
    return base64.b64encode(arr.tobytes()).decode()


def unb64(s, typecode):
    a = array.array(typecode)
    a.frombytes(base64.b64decode(s))
    return a
