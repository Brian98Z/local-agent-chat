using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Text;
using System.Xml;

// Renders the documented safe SVG subset used for member avatars into a small bitmap.
// No external resources, scripts, text, filters or references are supported; unknown
// elements are skipped and any parse failure returns null so callers keep initials.
internal static class SvgAvatar
{
    private static readonly Dictionary<string, Bitmap> cache = new Dictionary<string, Bitmap>();
    private static readonly object gate = new object();

    public static Bitmap Get(string svg, int pixels)
    {
        if (String.IsNullOrWhiteSpace(svg) || pixels < 8 || pixels > 512) return null;
        string key = pixels.ToString(CultureInfo.InvariantCulture) + "|" + svg;
        lock (gate)
        {
            Bitmap cached;
            if (cache.TryGetValue(key, out cached)) return cached;
        }
        Bitmap rendered;
        try { rendered = Render(svg, pixels); }
        catch { rendered = null; }
        if (rendered != null)
        {
            lock (gate)
            {
                if (cache.Count >= 256) cache.Clear();
                cache[key] = rendered;
            }
        }
        return rendered;
    }

    private sealed class Primitive
    {
        public GraphicsPath Path;
        public Brush Fill;
        public Pen Stroke;
    }

    private sealed class Paint
    {
        public Color Fill = Color.Black;
        public bool HasFill = true;
        public Color Stroke = Color.Black;
        public bool HasStroke;
        public float Width = 1f;
        public float Opacity = 1f;
        public float FillOpacity = 1f;
        public float StrokeOpacity = 1f;
    }

    private static Bitmap Render(string svg, int pixels)
    {
        var settings = new XmlReaderSettings();
        settings.DtdProcessing = DtdProcessing.Prohibit;
        settings.XmlResolver = null;
        settings.IgnoreComments = true;
        settings.IgnoreProcessingInstructions = true;
        XmlDocument document = new XmlDocument();
        document.XmlResolver = null;
        using (var reader = XmlReader.Create(new StringReader(svg), settings))
            document.Load(reader);
        XmlElement root = document.DocumentElement;
        if (root == null || !String.Equals(root.LocalName, "svg", StringComparison.OrdinalIgnoreCase)) return null;

        float viewX = 0f, viewY = 0f, viewW = 64f, viewH = 64f;
        float[] viewBox = Numbers(root.GetAttribute("viewBox"));
        if (viewBox != null && viewBox.Length >= 4 && viewBox[2] > 0f && viewBox[3] > 0f)
        {
            viewX = viewBox[0]; viewY = viewBox[1]; viewW = viewBox[2]; viewH = viewBox[3];
        }
        else
        {
            float width = Number(root.GetAttribute("width"), 64f), height = Number(root.GetAttribute("height"), 64f);
            if (width > 0f && height > 0f) { viewW = width; viewH = height; }
        }

        var primitives = new List<Primitive>();
        var identity = new Matrix();
        Visit(root, identity, new Paint(), primitives, 0);

        Bitmap bitmap = new Bitmap(pixels, pixels, PixelFormat.Format32bppPArgb);
        using (Graphics graphics = Graphics.FromImage(bitmap))
        {
            graphics.Clear(Color.Transparent);
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.CompositingQuality = CompositingQuality.HighQuality;
            float scale = Math.Min(pixels / viewW, pixels / viewH);
            if (!(scale > 0f) || Single.IsInfinity(scale)) scale = 1f;
            var transform = new Matrix();
            transform.Scale(scale, scale, MatrixOrder.Append);
            transform.Translate((pixels - viewW * scale) / 2f - viewX * scale, (pixels - viewH * scale) / 2f - viewY * scale, MatrixOrder.Append);
            graphics.Transform = transform;
            foreach (Primitive primitive in primitives)
            {
                if (primitive.Fill != null) graphics.FillPath(primitive.Fill, primitive.Path);
                if (primitive.Stroke != null) graphics.DrawPath(primitive.Stroke, primitive.Path);
            }
        }
        foreach (Primitive primitive in primitives)
        {
            primitive.Path.Dispose();
            if (primitive.Fill != null) primitive.Fill.Dispose();
            if (primitive.Stroke != null) primitive.Stroke.Dispose();
        }
        return bitmap;
    }

    private static void Visit(XmlElement element, Matrix parentMatrix, Paint parentPaint, List<Primitive> output, int depth)
    {
        if (depth > 32 || output.Count >= 500) return;
        string name = element.LocalName.ToLowerInvariant();
        if (name == "svg" || name == "g")
        {
            Matrix matrix = Combine(parentMatrix, element.GetAttribute("transform"));
            Paint paint = Override(parentPaint, element);
            foreach (XmlNode node in element.ChildNodes)
            {
                XmlElement child = node as XmlElement;
                if (child != null) Visit(child, matrix, paint, output, depth + 1);
            }
            return;
        }

        GraphicsPath path = BuildShape(name, element);
        if (path == null) return;
        Matrix local = Combine(parentMatrix, element.GetAttribute("transform"));
        path.FillMode = FillMode.Winding;
        path.Transform(local);
        Paint style = Override(parentPaint, element);
        var primitive = new Primitive { Path = path };
        if (style.HasFill)
            primitive.Fill = new SolidBrush(Alpha(style.Fill, style.Opacity * style.FillOpacity));
        if (style.HasStroke)
        {
            float[] matrixValues = local.Elements;
            float determinant = local.IsInvertible ? Math.Abs(matrixValues[0] * matrixValues[3] - matrixValues[1] * matrixValues[2]) : 1f;
            float width = style.Width * (float)Math.Sqrt(Math.Max(0.0001f, determinant));
            primitive.Stroke = new Pen(Alpha(style.Stroke, style.Opacity * style.StrokeOpacity), Math.Max(0.2f, width));
        }
        if (primitive.Fill != null || primitive.Stroke != null) output.Add(primitive);
        else path.Dispose();
    }

    private static Paint Override(Paint source, XmlElement element)
    {
        var paint = new Paint
        {
            Fill = source.Fill,
            HasFill = source.HasFill,
            Stroke = source.Stroke,
            HasStroke = source.HasStroke,
            Width = source.Width,
            Opacity = source.Opacity,
            FillOpacity = source.FillOpacity,
            StrokeOpacity = source.StrokeOpacity,
        };
        string value = element.GetAttribute("fill");
        if (value.Length > 0)
        {
            if (value.Equals("none", StringComparison.OrdinalIgnoreCase)) paint.HasFill = false;
            else { Color color; if (TryColor(value, out color)) { paint.Fill = color; paint.HasFill = true; } }
        }
        value = element.GetAttribute("stroke");
        if (value.Length > 0)
        {
            if (value.Equals("none", StringComparison.OrdinalIgnoreCase)) paint.HasStroke = false;
            else { Color color; if (TryColor(value, out color)) { paint.Stroke = color; paint.HasStroke = true; } }
        }
        value = element.GetAttribute("stroke-width");
        if (value.Length > 0) paint.Width = Number(value, paint.Width);
        value = element.GetAttribute("opacity");
        if (value.Length > 0) paint.Opacity *= Clamp(Number(value, 1f));
        value = element.GetAttribute("fill-opacity");
        if (value.Length > 0) paint.FillOpacity *= Clamp(Number(value, 1f));
        value = element.GetAttribute("stroke-opacity");
        if (value.Length > 0) paint.StrokeOpacity *= Clamp(Number(value, 1f));
        return paint;
    }

    private static GraphicsPath BuildShape(string name, XmlElement element)
    {
        var path = new GraphicsPath();
        try
        {
            switch (name)
            {
                case "rect":
                {
                    float x = Number(element.GetAttribute("x"), 0f), y = Number(element.GetAttribute("y"), 0f);
                    float w = Number(element.GetAttribute("width"), 0f), h = Number(element.GetAttribute("height"), 0f);
                    if (!(w > 0f) || !(h > 0f)) { path.Dispose(); return null; }
                    float rx = Number(element.GetAttribute("rx"), 0f), ry = Number(element.GetAttribute("ry"), 0f);
                    if (rx <= 0f && ry <= 0f) path.AddRectangle(new RectangleF(x, y, w, h));
                    else
                    {
                        if (rx <= 0f) rx = ry;
                        if (ry <= 0f) ry = rx;
                        rx = Math.Min(rx, w / 2f); ry = Math.Min(ry, h / 2f);
                        path.AddArc(x, y, rx * 2f, ry * 2f, 180f, 90f);
                        path.AddArc(x + w - rx * 2f, y, rx * 2f, ry * 2f, 270f, 90f);
                        path.AddArc(x + w - rx * 2f, y + h - ry * 2f, rx * 2f, ry * 2f, 0f, 90f);
                        path.AddArc(x, y + h - ry * 2f, rx * 2f, ry * 2f, 90f, 90f);
                        path.CloseFigure();
                    }
                    return path;
                }
                case "circle":
                {
                    float cx = Number(element.GetAttribute("cx"), 0f), cy = Number(element.GetAttribute("cy"), 0f);
                    float r = Number(element.GetAttribute("r"), 0f);
                    if (!(r > 0f)) { path.Dispose(); return null; }
                    path.AddEllipse(cx - r, cy - r, r * 2f, r * 2f);
                    return path;
                }
                case "ellipse":
                {
                    float cx = Number(element.GetAttribute("cx"), 0f), cy = Number(element.GetAttribute("cy"), 0f);
                    float rx = Number(element.GetAttribute("rx"), 0f), ry = Number(element.GetAttribute("ry"), 0f);
                    if (!(rx > 0f) || !(ry > 0f)) { path.Dispose(); return null; }
                    path.AddEllipse(cx - rx, cy - ry, rx * 2f, ry * 2f);
                    return path;
                }
                case "line":
                {
                    path.AddLine(Number(element.GetAttribute("x1"), 0f), Number(element.GetAttribute("y1"), 0f),
                                 Number(element.GetAttribute("x2"), 0f), Number(element.GetAttribute("y2"), 0f));
                    return path;
                }
                case "polyline":
                case "polygon":
                {
                    float[] points = Numbers(element.GetAttribute("points"));
                    if (points == null || points.Length < 4) { path.Dispose(); return null; }
                    var list = new List<PointF>();
                    for (int index = 0; index + 1 < points.Length; index += 2) list.Add(new PointF(points[index], points[index + 1]));
                    path.AddLines(list.ToArray());
                    if (name == "polygon") path.CloseFigure();
                    return path;
                }
                case "path":
                {
                    string data = element.GetAttribute("d");
                    if (String.IsNullOrWhiteSpace(data)) { path.Dispose(); return null; }
                    if (!BuildPath(data, path)) { path.Dispose(); return null; }
                    return path;
                }
                default:
                    path.Dispose();
                    return null;
            }
        }
        catch
        {
            path.Dispose();
            return null;
        }
    }

    private static bool BuildPath(string data, GraphicsPath path)
    {
        int index = 0;
        char command = '\0';
        PointF current = PointF.Empty, start = PointF.Empty, lastControl = PointF.Empty;
        char previous = '\0';
        bool any = false;
        while (index < data.Length)
        {
            SkipSeparators(data, ref index);
            if (index >= data.Length) break;
            char next = data[index];
            if (Char.IsLetter(next)) { command = next; index++; }
            else if (command == '\0') return false;
            if (command == 'z' || command == 'Z')
            {
                path.CloseFigure();
                current = start;
                previous = command;
                any = true;
                command = '\0';
                continue;
            }
            bool relative = Char.IsLower(command);
            float[] values;
            int count = PathArity(command, out values);
            if (count <= 0) return false;
            SkipSeparators(data, ref index);
            values = new float[count];
            for (int number = 0; number < count; number++)
            {
                if (!ReadNumber(data, ref index, out values[number])) return false;
                SkipSeparators(data, ref index);
            }
            float x = values[0], y = values[1];
            switch (Char.ToUpperInvariant(command))
            {
                case 'M':
                    if (relative) { x += current.X; y += current.Y; }
                    path.StartFigure();
                    path.AddLine(x, y, x, y);
                    current = new PointF(x, y); start = current;
                    command = relative ? 'l' : 'L';
                    break;
                case 'L':
                    if (relative) { x += current.X; y += current.Y; }
                    path.AddLine(current, new PointF(x, y)); current = new PointF(x, y);
                    break;
                case 'H':
                    if (relative) x += current.X;
                    path.AddLine(current, new PointF(x, current.Y)); current = new PointF(x, current.Y);
                    break;
                case 'V':
                    if (relative) y += current.Y;
                    path.AddLine(current, new PointF(current.X, y)); current = new PointF(current.X, y);
                    break;
                case 'C':
                {
                    PointF c1 = new PointF(values[0], values[1]), c2 = new PointF(values[2], values[3]), end = new PointF(values[4], values[5]);
                    if (relative)
                    {
                        c1 = Offset(c1, current); c2 = Offset(c2, current); end = Offset(end, current);
                    }
                    path.AddBezier(current, c1, c2, end);
                    lastControl = c2; current = end;
                    break;
                }
                case 'S':
                {
                    PointF c1 = (previous == 'C' || previous == 'c' || previous == 'S' || previous == 's') ? Reflect(lastControl, current) : current;
                    PointF c2 = new PointF(values[0], values[1]), end = new PointF(values[2], values[3]);
                    if (relative) { c2 = Offset(c2, current); end = Offset(end, current); }
                    path.AddBezier(current, c1, c2, end);
                    lastControl = c2; current = end;
                    break;
                }
                case 'Q':
                {
                    PointF control = new PointF(values[0], values[1]), end = new PointF(values[2], values[3]);
                    if (relative) { control = Offset(control, current); end = Offset(end, current); }
                    AddQuadratic(path, current, control, end);
                    lastControl = control; current = end;
                    break;
                }
                case 'T':
                {
                    PointF control = (previous == 'Q' || previous == 'q' || previous == 'T' || previous == 't') ? Reflect(lastControl, current) : current;
                    PointF end = new PointF(values[0], values[1]);
                    if (relative) end = Offset(end, current);
                    AddQuadratic(path, current, control, end);
                    lastControl = control; current = end;
                    break;
                }
                case 'A':
                {
                    PointF end = new PointF(values[5], values[6]);
                    if (relative) end = Offset(end, current);
                    AddArc(path, current, values[0], values[1], values[2], values[3] != 0f, values[4] != 0f, end);
                    current = end;
                    break;
                }
                default:
                    return false;
            }
            previous = command;
            any = true;
        }
        return any;
    }

    private static int PathArity(char command, out float[] ignored)
    {
        ignored = null;
        switch (Char.ToUpperInvariant(command))
        {
            case 'M': case 'L': case 'T': return 2;
            case 'H': case 'V': return 1;
            case 'C': return 6;
            case 'S': case 'Q': return 4;
            case 'A': return 7;
            default: return 0;
        }
    }

    private static void AddQuadratic(GraphicsPath path, PointF start, PointF control, PointF end)
    {
        var c1 = new PointF(start.X + (control.X - start.X) * 2f / 3f, start.Y + (control.Y - start.Y) * 2f / 3f);
        var c2 = new PointF(end.X + (control.X - end.X) * 2f / 3f, end.Y + (control.Y - end.Y) * 2f / 3f);
        path.AddBezier(start, c1, c2, end);
    }

    private static void AddArc(GraphicsPath path, PointF from, float rx, float ry, float rotation, bool large, bool sweep, PointF to)
    {
        rx = Math.Abs(rx); ry = Math.Abs(ry);
        if (rx <= 0f || ry <= 0f || (from.X == to.X && from.Y == to.Y))
        {
            path.AddLine(from, to);
            return;
        }
        double phi = rotation * Math.PI / 180d;
        double cos = Math.Cos(phi), sin = Math.Sin(phi);
        double dx = (from.X - to.X) / 2d, dy = (from.Y - to.Y) / 2d;
        double x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
        double lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
        if (lambda > 1d) { rx = (float)(rx * Math.Sqrt(lambda)); ry = (float)(ry * Math.Sqrt(lambda)); }
        double sign = large == sweep ? -1d : 1d;
        double numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
        double denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
        double coefficient = denominator == 0d ? 0d : sign * Math.Sqrt(Math.Max(0d, numerator / denominator));
        double cx1 = coefficient * rx * y1 / ry, cy1 = -coefficient * ry * x1 / rx;
        double cx = cos * cx1 - sin * cy1 + (from.X + to.X) / 2d;
        double cy = sin * cx1 + cos * cy1 + (from.Y + to.Y) / 2d;
        double ux = (x1 - cx1) / rx, uy = (y1 - cy1) / ry;
        double vx = (-x1 - cx1) / rx, vy = (-y1 - cy1) / ry;
        double startAngle = Math.Atan2(uy, ux);
        double delta = Math.Atan2(ux * vy - uy * vx, ux * vx + uy * vy);
        if (!sweep && delta > 0d) delta -= 2d * Math.PI;
        if (sweep && delta < 0d) delta += 2d * Math.PI;
        int steps = Math.Max(2, (int)Math.Ceiling(Math.Abs(delta) / (Math.PI / 12d)));
        PointF previous = from;
        for (int step = 1; step <= steps; step++)
        {
            double angle = startAngle + delta * step / steps;
            double px = cx + rx * Math.Cos(angle) * cos - ry * Math.Sin(angle) * sin;
            double py = cy + rx * Math.Cos(angle) * sin + ry * Math.Sin(angle) * cos;
            var point = new PointF((float)px, (float)py);
            path.AddLine(previous, point);
            previous = point;
        }
    }

    private static PointF Offset(PointF point, PointF origin)
    {
        return new PointF(point.X + origin.X, point.Y + origin.Y);
    }

    private static PointF Reflect(PointF control, PointF origin)
    {
        return new PointF(2f * origin.X - control.X, 2f * origin.Y - control.Y);
    }

    private static Matrix Combine(Matrix parent, string transform)
    {
        var matrix = parent.Clone();
        if (String.IsNullOrWhiteSpace(transform)) return matrix;
        int index = 0;
        while (index < transform.Length)
        {
            while (index < transform.Length && (Char.IsWhiteSpace(transform[index]) || transform[index] == ',')) index++;
            int start = index;
            while (index < transform.Length && Char.IsLetter(transform[index])) index++;
            string kind = transform.Substring(start, index - start).ToLowerInvariant();
            while (index < transform.Length && transform[index] != '(') index++;
            int close = transform.IndexOf(')', index);
            if (close < 0) break;
            float[] values = Numbers(transform.Substring(index + 1, close - index - 1));
            index = close + 1;
            if (values == null) continue;
            var local = new Matrix();
            if (kind == "translate" && values.Length >= 1)
                local.Translate(values[0], values.Length > 1 ? values[1] : 0f);
            else if (kind == "scale" && values.Length >= 1)
                local.Scale(values[0], values.Length > 1 ? values[1] : values[0]);
            else if (kind == "rotate" && values.Length >= 1)
            {
                if (values.Length >= 3) { local.Translate(values[1], values[2], MatrixOrder.Append); local.Rotate(values[0], MatrixOrder.Append); local.Translate(-values[1], -values[2], MatrixOrder.Append); }
                else local.Rotate(values[0]);
            }
            else if (kind == "matrix" && values.Length >= 6)
                local = new Matrix(values[0], values[1], values[2], values[3], values[4], values[5]);
            else if (kind == "skewx" && values.Length >= 1)
                local.Shear((float)Math.Tan(values[0] * Math.PI / 180d), 0f);
            else if (kind == "skewy" && values.Length >= 1)
                local.Shear(0f, (float)Math.Tan(values[0] * Math.PI / 180d));
            matrix.Multiply(local, MatrixOrder.Append);
        }
        return matrix;
    }

    private static Color Alpha(Color color, float opacity)
    {
        int alpha = (int)Math.Round(255 * Clamp(opacity));
        return Color.FromArgb(alpha, color.R, color.G, color.B);
    }

    private static float Clamp(float value)
    {
        if (Single.IsNaN(value)) return 0f;
        return Math.Max(0f, Math.Min(1f, value));
    }

    private static bool TryColor(string value, out Color color)
    {
        color = Color.Empty;
        value = value.Trim();
        if (value.Length == 0) return false;
        if (value[0] == '#')
        {
            string hex = value.Substring(1);
            try
            {
                if (hex.Length == 3)
                    color = Color.FromArgb(255, Convert.ToInt32(new string(hex[0], 2), 16), Convert.ToInt32(new string(hex[1], 2), 16), Convert.ToInt32(new string(hex[2], 2), 16));
                else if (hex.Length == 6)
                    color = Color.FromArgb(255, Convert.ToInt32(hex.Substring(0, 2), 16), Convert.ToInt32(hex.Substring(2, 2), 16), Convert.ToInt32(hex.Substring(4, 2), 16));
                else return false;
                return true;
            }
            catch { return false; }
        }
        if (value.StartsWith("rgb", StringComparison.OrdinalIgnoreCase))
        {
            int open = value.IndexOf('('), close = value.LastIndexOf(')');
            if (open < 0 || close <= open) return false;
            float[] parts = Numbers(value.Substring(open + 1, close - open - 1));
            if (parts != null && parts.Length >= 3)
            {
                color = Color.FromArgb(255,
                    (int)Math.Round(Math.Max(0f, Math.Min(255f, parts[0]))),
                    (int)Math.Round(Math.Max(0f, Math.Min(255f, parts[1]))),
                    (int)Math.Round(Math.Max(0f, Math.Min(255f, parts[2]))));
                return true;
            }
            return false;
        }
        Color named = Color.FromName(value);
        if (named.IsKnownColor || named.A > 0)
        {
            color = named;
            return true;
        }
        return false;
    }

    private static void SkipSeparators(string text, ref int index)
    {
        while (index < text.Length && (Char.IsWhiteSpace(text[index]) || text[index] == ',')) index++;
    }

    private static bool ReadNumber(string text, ref int index, out float value)
    {
        value = 0f;
        SkipSeparators(text, ref index);
        int start = index;
        if (index < text.Length && (text[index] == '+' || text[index] == '-')) index++;
        bool digits = false;
        while (index < text.Length && Char.IsDigit(text[index])) { index++; digits = true; }
        if (index < text.Length && text[index] == '.')
        {
            index++;
            while (index < text.Length && Char.IsDigit(text[index])) { index++; digits = true; }
        }
        if (!digits) { index = start; return false; }
        if (index < text.Length && (text[index] == 'e' || text[index] == 'E'))
        {
            int exponent = index;
            index++;
            if (index < text.Length && (text[index] == '+' || text[index] == '-')) index++;
            bool exponentDigits = false;
            while (index < text.Length && Char.IsDigit(text[index])) { index++; exponentDigits = true; }
            if (!exponentDigits) index = exponent;
        }
        return Single.TryParse(text.Substring(start, index - start), NumberStyles.Float, CultureInfo.InvariantCulture, out value);
    }

    private static float Number(string value, float fallback)
    {
        if (String.IsNullOrWhiteSpace(value)) return fallback;
        int index = 0;
        float parsed;
        return ReadNumber(value, ref index, out parsed) ? parsed : fallback;
    }

    private static float[] Numbers(string value)
    {
        if (String.IsNullOrWhiteSpace(value)) return null;
        var list = new List<float>();
        int index = 0;
        while (index < value.Length)
        {
            SkipSeparators(value, ref index);
            if (index >= value.Length) break;
            float parsed;
            if (!ReadNumber(value, ref index, out parsed)) break;
            list.Add(parsed);
        }
        return list.Count == 0 ? null : list.ToArray();
    }
}
