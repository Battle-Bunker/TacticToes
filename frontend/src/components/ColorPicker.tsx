import React, { useEffect, useRef, useState } from "react";
import {
  Box,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  ButtonBase,
  Tooltip,
  useMediaQuery,
  useTheme,
  IconButton,
} from "@mui/material";
import {
  Palette as PaletteIcon,
  ColorLens as ColorLensIcon,
  ArrowBack as ArrowBackIcon,
  Close as CloseIcon,
} from "@mui/icons-material";
import { Sketch } from "@uiw/react-color";

interface ColorPickerProps {
  selectedColor: string;
  onColorChange: (color: string) => void;
  label?: string;
}

// Curated color palette - organized by hue families with good contrast
const COLOR_PALETTE = [
  // Reds & Pinks
  "#E53E3E", // Red
  "#FC8181", // Light Red
  "#F56565", // Rose Red

  // Oranges & Yellows
  "#DD6B20", // Orange
  "#F6AD55", // Light Orange
  "#ECC94B", // Yellow

  // Greens
  "#38A169", // Green
  "#68D391", // Light Green
  "#48BB78", // Emerald

  // Blues & Cyans
  "#3182CE", // Blue
  "#63B3ED", // Light Blue
  "#38B2AC", // Teal

  // Purples & Violets
  "#805AD5", // Purple
  "#B794F6", // Light Purple
  "#9F7AEA", // Violet

  // Grays & Neutrals
  "#4A5568", // Dark Gray
  "#A0AEC0", // Light Gray
  "#2D3748", // Charcoal
];

type ViewMode = "palette" | "custom";

export const ColorPicker: React.FC<ColorPickerProps> = ({
  selectedColor,
  onColorChange,
  label = "Team Color",
}) => {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ViewMode>("palette");
  const [customColor, setCustomColor] = useState(selectedColor);

  const theme = useTheme();
  const isXs = useMediaQuery(theme.breakpoints.down("sm"));

  const handleOpenDialog = () => {
    setCustomColor(selectedColor);
    setView("palette");
    setOpen(true);
  };

  const handleClose = () => setOpen(false);

  const handleColorSelect = (color: string) => {
    onColorChange(color);
    setOpen(false);
  };

  const goToCustom = () => {
    setCustomColor(selectedColor);
    setView("custom");
  };

  

  const handleCustomColorChange = (value: string) => {
    setCustomColor(value);
    onColorChange(value); // live-apply
  };

  return (
    <>
      {/* Trigger (compact, responsive label) */}
      <ButtonBase
        onClick={handleOpenDialog}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1,
          py: 0.75,
          borderRadius: 1,
          border: "2px solid transparent",
          "&:hover": {
            border: "2px solid #1976d2",
            bgcolor: "rgba(25,118,210,0.04)",
          },
          transition: "all 0.2s ease-in-out",
        }}
      >
        <Box
          sx={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            bgcolor: selectedColor,
            border: "2px solid #fff",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            "&::after": {
              content: '""',
              position: "absolute",
              inset: 0,
              borderRadius: "50%",
              border: "1px solid rgba(0,0,0,0.1)",
            },
          }}
        >
          <ColorLensIcon
            sx={{
              fontSize: 16,
              color: "#fff",
              filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.3))",
            }}
          />
        </Box>
        <Typography
          variant="body2"
          sx={{
            fontWeight: 500,
            color: "#666",
            lineHeight: 1,
            flex: "0 1 auto",
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 160,
          }}
        >
          {label}
        </Typography>
      </ButtonBase>

      {/* Dialog */}
      <Dialog
        open={open}
        onClose={handleClose}
        maxWidth="sm"
        fullWidth
        PaperProps={{
          sx: {
            borderRadius: 2,
            boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
            overflow: "hidden",
          },
        }}
      >
        <DialogTitle
          sx={{ display: "flex", alignItems: "center", gap: 1, pr: 5 }}
        >
          {view === "custom" ? (
            <>
              <IconButton
                size="small"
                onClick={() => setView("palette")}
                aria-label="Back to quick colors"
              >
                <ArrowBackIcon />
              </IconButton>
              <Typography variant="h6" sx={{ flex: 1 }}>
                Custom Color
              </Typography>
            </>
          ) : (
            <>
              <PaletteIcon />
              <Typography variant="h6" sx={{ flex: 1 }}>
                Choose Team Color
              </Typography>
            </>
          )}
          <IconButton
            onClick={handleClose}
            aria-label="Close"
            sx={{ position: "absolute", right: 8, top: 8 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>

        <DialogContent sx={{ pt: 1.5, pb: 2 }}>
          {view === "palette" ? (
            <>
              {/* Predefined Color Palette */}
              <Typography variant="subtitle2" sx={{ mb: 2, fontWeight: 600 }}>
                Quick Colors
              </Typography>
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: {
                    xs: "repeat(5, 1fr)",
                    sm: "repeat(6, 1fr)",
                  },
                  gap: 1.5,
                  mb: 2.5,
                }}
              >
                {COLOR_PALETTE.map((color) => (
                  <Tooltip key={color} title={color} arrow>
                    <Box
                      role="button"
                      aria-label={`Select ${color}`}
                      tabIndex={0}
                      onClick={() => handleColorSelect(color)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleColorSelect(color);
                        }
                      }}
                      sx={{
                        width: 44,
                        height: 44,
                        borderRadius: "50%",
                        bgcolor: color,
                        cursor: "pointer",
                        border:
                          selectedColor === color
                            ? "3px solid #1976d2"
                            : "3px solid transparent",
                        transition: "all 0.2s ease-in-out",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        position: "relative",
                        "&:hover": {
                          transform: "scale(1.08)",
                          boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
                          border: "3px solid #1976d2",
                        },
                        "&::after": {
                          content: '""',
                          position: "absolute",
                          inset: 0,
                          borderRadius: "50%",
                          border: "1px solid rgba(0,0,0,0.08)",
                        },
                      }}
                    >
                      {selectedColor === color && (
                        <Box
                          sx={{
                            color: "#fff",
                            fontSize: "18px",
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

              {/* Custom Color CTA */}
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 2,
                  p: 1.5,
                  borderRadius: 1.5,
                  bgcolor: "rgba(25,118,210,0.05)",
                  border: "1px solid rgba(25,118,210,0.2)",
                  cursor: "pointer",
                  transition: "all .2s",
                  "&:hover": { bgcolor: "rgba(25,118,210,0.08)" },
                }}
                onClick={goToCustom}
              >
                <input
                  type="color"
                  // keep it small just to preview; clicking the row navigates to full custom view
                  value={customColor}
                  onChange={(e) => setCustomColor(e.target.value)}
                  style={{
                    width: 36,
                    height: 36,
                    border: "none",
                    borderRadius: 8,
                    cursor: "pointer",
                    outline: "none",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
                  }}
                  onClick={(e) => {
                    // prevent native picker here; we want to go to the dedicated custom view
                    e.preventDefault();
                    e.stopPropagation();
                    goToCustom();
                  }}
                />
                <Box
                  sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}
                >
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    Custom color…
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{ color: "text.secondary" }}
                  >
                    Open full color selector
                  </Typography>
                </Box>
              </Box>
            </>
          ) : (
            // CUSTOM VIEW (using @uiw/react-color)
            <Box
              sx={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                py: { xs: 2, sm: 3 },
                gap: 2,
              }}
            >
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                Pick any color
              </Typography>

              {/* @uiw/react-color Sketch picker */}
              <Box
                sx={{
                  "& .w-color-sketch": {
                    boxShadow: "0 8px 24px rgba(0,0,0,0.12) !important",
                    borderRadius: "8px !important",
                  },
                }}
              >
                <Sketch
                  color={customColor}
                  onChange={(color) => handleCustomColorChange(color.hex)}
                  disableAlpha={true}
                />
              </Box>

              {/* Readout */}
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  mt: 0.5,
                }}
              >
                <Box
                  sx={{
                    width: 28,
                    height: 28,
                    borderRadius: 1,
                    bgcolor: customColor,
                    border: "1px solid rgba(0,0,0,0.12)",
                  }}
                />
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {customColor.toUpperCase()}
                </Typography>
              </Box>
            </Box>
          )}
        </DialogContent>

        <DialogActions sx={{ p: 1.5 }}>
          <Button onClick={handleClose} color="inherit">
            Cancel
          </Button>
          {view === "custom" ? (
            <Button onClick={() => setOpen(false)} disableElevation>
              Done
            </Button>
          ) : null}
        </DialogActions>
      </Dialog>
    </>
  );
};
