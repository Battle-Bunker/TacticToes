import React, { useState } from "react";
import {
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Box,
  Typography,
  Tooltip,
} from "@mui/material";
import { Palette, ColorLens } from "@mui/icons-material";

interface ColorPickerProps {
  selectedColor: string;
  onColorChange: (color: string) => void;
  label?: string;
}

// Beautiful predefined color palette
const COLOR_PALETTE = [
  "#FF6B6B", // Red
  "#4ECDC4", // Teal
  "#45B7D1", // Blue
  "#96CEB4", // Mint
  "#FFEAA7", // Yellow
  "#DDA0DD", // Plum
  "#98D8C8", // Seafoam
  "#F7DC6F", // Gold
  "#BB8FCE", // Lavender
  "#85C1E9", // Sky Blue
  "#F8C471", // Peach
  "#82E0AA", // Light Green
  "#F1948A", // Coral
  "#85C1E9", // Light Blue
  "#D7BDE2", // Light Purple
  "#A9DFBF", // Light Mint
  "#F9E79F", // Light Yellow
  "#E8DAEF", // Very Light Purple
  "#D5DBDB", // Silver
  "#FADBD8", // Rose
];

export const ColorPicker: React.FC<ColorPickerProps> = ({
  selectedColor,
  onColorChange,
  label = "Color",
}) => {
  const [open, setOpen] = useState(false);
  const [customColor, setCustomColor] = useState("#000000");

  const handleColorSelect = (color: string) => {
    onColorChange(color);
    setOpen(false);
  };

  const handleCustomColorChange = (color: string) => {
    setCustomColor(color);
    onColorChange(color); // Automatically apply the custom color
  };

  const handleOpenDialog = () => {
    setCustomColor(selectedColor);
    setOpen(true);
  };

  return (
    <>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          cursor: "pointer",
          padding: 1,
          borderRadius: 1,
          border: "2px solid transparent",
          "&:hover": {
            border: "2px solid #1976d2",
            backgroundColor: "rgba(25, 118, 210, 0.04)",
          },
          transition: "all 0.2s ease-in-out",
        }}
        onClick={handleOpenDialog}
      >
        <Box
          sx={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            backgroundColor: selectedColor,
            border: "2px solid #fff",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            "&::after": {
              content: '""',
              position: "absolute",
              width: "100%",
              height: "100%",
              borderRadius: "50%",
              border: "1px solid rgba(0,0,0,0.1)",
            },
          }}
        >
          <ColorLens sx={{ fontSize: 16, color: "#fff", filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.3))" }} />
        </Box>
        <Typography variant="body2" sx={{ fontWeight: 500, color: "#666" }}>
          {label}
        </Typography>
      </Box>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        maxWidth="sm"
        fullWidth
        PaperProps={{
          sx: {
            borderRadius: 2,
            boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
          },
        }}
      >
        <DialogTitle sx={{ pb: 1 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Palette color="primary" />
            <Typography variant="h6">Choose Team Color</Typography>
          </Box>
        </DialogTitle>

        <DialogContent sx={{ pt: 2 }}>
          {/* Predefined Color Palette */}
          <Typography variant="subtitle2" sx={{ mb: 2, fontWeight: 600 }}>
            Quick Colors
          </Typography>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "repeat(5, 1fr)",
              gap: 1.5,
              mb: 3,
            }}
          >
            {COLOR_PALETTE.map((color) => (
              <Tooltip key={color} title={color} arrow>
                <Box
                  sx={{
                    width: 48,
                    height: 48,
                    borderRadius: "50%",
                    backgroundColor: color,
                    cursor: "pointer",
                    border: selectedColor === color ? "3px solid #1976d2" : "3px solid transparent",
                    transition: "all 0.2s ease-in-out",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    position: "relative",
                    "&:hover": {
                      transform: "scale(1.1)",
                      boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
                      border: "3px solid #1976d2",
                    },
                    "&::after": {
                      content: '""',
                      position: "absolute",
                      width: "100%",
                      height: "100%",
                      borderRadius: "50%",
                      border: "1px solid rgba(0,0,0,0.1)",
                    },
                  }}
                  onClick={() => handleColorSelect(color)}
                >
                  {selectedColor === color && (
                    <Box
                      sx={{
                        color: "#fff",
                        fontSize: "20px",
                        filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.3))",
                      }}
                    >
                      ✓
                    </Box>
                  )}
                </Box>
              </Tooltip>
            ))}
          </Box>

          {/* Custom Color Picker */}
          <Typography variant="subtitle2" sx={{ mb: 2, fontWeight: 600 }}>
            Custom Color
          </Typography>
          <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
            <Box
              sx={{
                width: 48,
                height: 48,
                borderRadius: "50%",
                backgroundColor: customColor,
                border: selectedColor === customColor ? "3px solid #1976d2" : "3px solid #e0e0e0",
                cursor: "pointer",
                position: "relative",
                transition: "all 0.2s ease-in-out",
                "&:hover": {
                  transform: "scale(1.05)",
                  border: "3px solid #1976d2",
                },
                "&::after": {
                  content: '""',
                  position: "absolute",
                  width: "100%",
                  height: "100%",
                  borderRadius: "50%",
                  border: "1px solid rgba(0,0,0,0.1)",
                },
              }}
              onClick={() => handleColorSelect(customColor)}
            >
              {selectedColor === customColor && (
                <Box
                  sx={{
                    color: "#fff",
                    fontSize: "20px",
                    filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.3))",
                  }}
                >
                  ✓
                </Box>
              )}
            </Box>
            <input
              type="color"
              value={customColor}
              onChange={(e) => handleCustomColorChange(e.target.value)}
              style={{
                width: 40,
                height: 40,
                border: "none",
                borderRadius: "50%",
                cursor: "pointer",
                outline: "none",
              }}
            />
            <Typography variant="body2" sx={{ color: "#666", fontStyle: "italic" }}>
              Click to select custom color
            </Typography>
          </Box>
        </DialogContent>

        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setOpen(false)} color="inherit">
            Cancel
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};
